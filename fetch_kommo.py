#!/usr/bin/env python3
"""
Puxa os leads do Kommo (Taiyo Honda) e grava agregados em data/kommo.json.

IMPORTANTE: o arquivo gerado NAO contem PII (nome, telefone, email).
So numeros agregados, porque o repositorio e publico.
"""
import os
import re
import json
import time
import urllib.request
import urllib.error
import collections
from datetime import datetime, timedelta, timezone

SUBDOMAIN = os.environ.get("KOMMO_SUBDOMAIN", "taiyohonda")
TOKEN = os.environ.get("KOMMO_TOKEN", "")
BASE = f"https://{SUBDOMAIN}.kommo.com/api/v4"

# Fuso de Brasilia (UTC-3, sem horario de verao)
BRT = timezone(timedelta(hours=-3))

DIAS_HISTORICO = 180

PIPELINES = {
    12760795: "novos",
    13274704: "posvendas",
    12768987: "nutricao",
    13636676: "seminovos",
}

STATUS_NOMES = {
    # Novos
    98470187: "Leads de entrada",
    98470191: "Lead Novo",
    98524855: "Follow-up",
    109051148: "Follow-up 24h",
    109051152: "Follow-up 48h",
    98470195: "Em Atendimento",
    98470203: "Encaminhado para Vendas",
    98524647: "Visita / Test-Drive",
    98524651: "Aguardando Faturamento",
    98630271: "Venda Futura",
    # Pos-venda
    102365880: "Leads de entrada",
    102365884: "Lead Novo",
    102365888: "Follow-up",
    102365892: "Em atendimento",
    102442840: "Agendado",
    # Nutricao
    98530327: "Leads de entrada",
    98530331: "Nutricao",
    # Seminovos
    105239208: "Leads de entrada",
    105239212: "Em atendimento",
    105239264: "Visita",
    105239268: "Aguardando faturamento",
    # Sistema
    142: "Ganho",
    143: "Perdido",
}

# Etapas na ordem do funil, por pipeline (sem Ganho/Perdido)
FUNIL = {
    "novos": [98470187, 98470191, 98524855, 109051148, 109051152,
              98470195, 98470203, 98524647, 98524651],
    "posvendas": [102365880, 102365884, 102365888, 102365892, 102442840],
    "nutricao": [98530327, 98530331],
    "seminovos": [105239208, 105239212, 105239264, 105239268],
}

# Etapas cujo alcance e contado pela TAG e nao pelo status.
# O Kommo tem uma automacao que marca a tag quando o lead entra na etapa, e a
# tag fica no lead mesmo depois que ele sai — entao ela e o registro mais fiel
# de "passou por aqui" do que o status atual ou o historico de 90 dias.
TAG_ETAPA = {
    98470203: "Encaminhado",             # Novos > Encaminhado para Vendas
    98524647: "Visita/Test-Drive",       # Novos > Visita / Test-Drive
    98524651: "Aguardando faturamento",  # Novos > Aguardando Faturamento
}

CF = {
    "utm_source": 3043886,
    "utm_campaign": 3043884,
    "utm_content": 3043880,
    "utm_medium": 3043882,
    "fbclid": 3043898,
    "setor": 3083138,
    "modelo": 3083140,
    "vendedor": 3083350,
    "unidade": 3160310,
    "campanha": 3665023,
    "publico": 3665025,
    "criativo": 4331969,
    "followup": 4223340,
}

# Normalizacao de "Modelo de interesse" (campo texto livre)
MODELOS = [
    ("HR-V", r"hr[\s\-_]*v"),
    ("ZR-V", r"zr[\s\-_]*v"),
    ("WR-V", r"wr[\s\-_]*v"),
    ("CR-V", r"cr[\s\-_]*v"),
    ("CITY HATCH", r"city\s*hat"),
    ("CITY", r"\bcity\b"),
    ("CIVIC", r"civic"),
    ("ACCORD", r"accord"),
    ("FIT", r"\bfit\b"),
    ("BIZ", r"\bbiz\b"),
    ("CG 160", r"cg\s*160"),
    ("POP 110", r"pop\s*110"),
    ("PCX", r"\bpcx\b"),
    ("ELITE", r"elite"),
    ("XRE", r"\bxre\b"),
    ("BROS", r"bros"),
    ("CB", r"\bcb\s*\d"),
    ("CONSORCIO", r"cons[oó]rcio"),
]


def http_get(url, tentativas=4):
    for i in range(tentativas):
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {TOKEN}",
            "User-Agent": "taiyo-dashboard/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 204:
                return {}
            if e.code in (429, 500, 502, 503) and i < tentativas - 1:
                time.sleep(2 ** i)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if i < tentativas - 1:
                time.sleep(2 ** i)
                continue
            raise
    return {}


def baixar_historico(desde_ts):
    """
    Mapa lead_id -> conjunto de status pelos quais o lead ja passou.

    Sem isso o funil mente: um lead perdido na etapa 2 sumiria da contagem
    das etapas 1 e 2, e o topo do funil ficaria menor que o total de leads.
    """
    hist = collections.defaultdict(set)
    pipes = collections.defaultdict(set)
    page = 1
    while True:
        url = (f"{BASE}/events?filter[type][]=lead_status_changed"
               f"&filter[created_at][from]={desde_ts}&limit=100&page={page}")
        d = http_get(url)
        eventos = (d.get("_embedded") or {}).get("events") or []
        if not eventos:
            break
        for e in eventos:
            lid = e.get("entity_id")
            for campo in ("value_before", "value_after"):
                for v in (e.get(campo) or []):
                    st = (v or {}).get("lead_status") or {}
                    if st.get("id"):
                        hist[lid].add(st["id"])
                    if st.get("pipeline_id"):
                        pipes[lid].add(st["pipeline_id"])
        if page % 20 == 0:
            print(f"  historico: {page} paginas, {len(hist)} leads")
        if not ((d.get("_links") or {}).get("next")):
            break
        page += 1
        if page > 400:
            print("  [aviso] limite de 400 paginas de historico atingido")
            break
    return hist, pipes


def baixar_leads(desde_ts):
    """Pagina /leads trazendo loss_reason e tags."""
    leads = []
    page = 1
    while True:
        url = (f"{BASE}/leads?limit=250&page={page}"
               f"&filter[created_at][from]={desde_ts}"
               f"&with=loss_reason,contacts")
        d = http_get(url)
        if not d or "_embedded" not in d:
            break
        lote = d["_embedded"]["leads"]
        leads.extend(lote)
        print(f"  pagina {page}: {len(lote)} leads (total {len(leads)})")
        if len(lote) < 250:
            break
        page += 1
        if page > 200:
            print("  [aviso] limite de 200 paginas atingido")
            break
    return leads


def cf_valor(lead, field_id):
    for f in (lead.get("custom_fields_values") or []):
        if f.get("field_id") == field_id:
            vals = f.get("values") or []
            if not vals:
                return None
            v = vals[0].get("value")
            if isinstance(v, dict):
                return v.get("value")
            if isinstance(v, bool):
                return "Sim" if v else "Nao"
            return str(v).strip() or None
    return None


def normaliza_modelo(txt):
    if not txt:
        return None
    t = txt.lower().strip()
    for nome, pad in MODELOS:
        if re.search(pad, t):
            return nome
    # devolve capitalizado se for curto, senao agrupa em "Outros"
    limpo = re.sub(r"\s+", " ", txt.strip())
    return limpo.upper()[:24] if len(limpo) <= 24 else "OUTROS"


def motivo_perda(lead):
    e = (lead.get("_embedded") or {}).get("loss_reason")
    if isinstance(e, list) and e:
        return e[0].get("name")
    if isinstance(e, dict) and e:
        return e.get("name")
    return None


def tags(lead):
    return [t.get("name") for t in ((lead.get("_embedded") or {}).get("tags") or []) if t.get("name")]


def top(counter, n=12, rotulo_vazio=None):
    """Counter -> lista [{nome, valor}] ordenada, opcionalmente sem os vazios."""
    itens = [(k, v) for k, v in counter.items() if k is not None]
    if rotulo_vazio is None:
        itens = [(k, v) for k, v in itens if k != "(nao preenchido)"]
    itens.sort(key=lambda x: -x[1])
    return [{"nome": k, "valor": v} for k, v in itens[:n]]


def agrega_periodo(leads, funil_ids, hist):
    """Recebe os leads de um pipeline ja filtrados por periodo."""
    total = len(leads)
    ganhos = [l for l in leads if l["status_id"] == 142]
    perdidos = [l for l in leads if l["status_id"] == 143]
    abertos = [l for l in leads if l["status_id"] not in (142, 143)]
    receita = sum(l.get("price") or 0 for l in ganhos)

    # --- funil ---
    # Para cada lead, a etapa mais avancada que ele alcancou, juntando o
    # historico de mudancas de status ao status atual. Ganho conta como
    # "alem da ultima etapa".
    pos = {sid: i for i, sid in enumerate(funil_ids)}
    ultimo = len(funil_ids)

    def etapa_maxima(lead):
        idx = [pos[s] for s in hist.get(lead["id"], ()) if s in pos]
        atual = lead["status_id"]
        if atual in pos:
            idx.append(pos[atual])
        elif atual == 142:
            idx.append(ultimo)
        return max(idx) if idx else -1

    avanco = {l["id"]: etapa_maxima(l) for l in leads}

    etapas = []
    for i, sid in enumerate(funil_ids):
        tag = TAG_ETAPA.get(sid)
        if tag:
            alcancaram = sum(1 for l in leads if tag in tags(l))
        else:
            alcancaram = sum(1 for l in leads if avanco[l["id"]] >= i)
        etapas.append({
            "id": sid,
            "nome": STATUS_NOMES.get(sid, str(sid)),
            "parados": sum(1 for l in leads if l["status_id"] == sid),
            "alcancaram": alcancaram,
            "fonte": "tag" if tag else "status",
        })
    etapas.append({"id": 142, "nome": "Ganho", "parados": len(ganhos),
                   "alcancaram": len(ganhos), "fonte": "status"})

    # Um funil nao pode crescer: se uma etapa contada por tag ficar acima da
    # anterior (lead que ganhou a tag sem passar pelo status intermediario),
    # a etapa anterior absorve o valor, senao a barra fica maior que a de cima.
    for i in range(len(etapas) - 2, -1, -1):
        if etapas[i]["alcancaram"] < etapas[i + 1]["alcancaram"]:
            etapas[i]["alcancaram"] = etapas[i + 1]["alcancaram"]

    # onde os leads perdidos pararam
    perda_etapa = collections.Counter()
    for l in perdidos:
        i = avanco[l["id"]]
        perda_etapa[STATUS_NOMES.get(funil_ids[i], "?") if 0 <= i < len(funil_ids)
                    else "(sem etapa registrada)"] += 1

    # --- quebras ---
    c_vendedor = collections.Counter()
    c_vendedor_ganho = collections.Counter()
    v_vendedor_receita = collections.Counter()
    c_modelo = collections.Counter()
    c_unidade = collections.Counter()
    c_motivo = collections.Counter()
    c_campanha = collections.Counter()
    c_origem = collections.Counter()
    c_anuncio = collections.Counter()
    c_setor = collections.Counter()

    for l in leads:
        vend = cf_valor(l, CF["vendedor"]) or "(nao preenchido)"
        c_vendedor[vend] += 1
        if l["status_id"] == 142:
            c_vendedor_ganho[vend] += 1
            v_vendedor_receita[vend] += l.get("price") or 0

        c_modelo[normaliza_modelo(cf_valor(l, CF["modelo"])) or "(nao preenchido)"] += 1
        c_unidade[cf_valor(l, CF["unidade"]) or "(nao preenchido)"] += 1
        c_setor[cf_valor(l, CF["setor"]) or "(nao preenchido)"] += 1

        camp = cf_valor(l, CF["utm_campaign"]) or cf_valor(l, CF["campanha"])
        c_campanha[camp or "(nao preenchido)"] += 1

        origem = cf_valor(l, CF["utm_source"])
        if not origem:
            ts = tags(l)
            if any(t.startswith("fb") and t[2:].isdigit() for t in ts):
                origem = "Meta Ads (CTWA)"
            elif any("meta" in t.lower() or "patrocinado" in t.lower() for t in ts):
                origem = "Meta Ads (tag)"
            elif any("reativado" in t.lower() for t in ts):
                origem = "Reativacao"
            else:
                origem = "(nao identificado)"
        c_origem[origem] += 1

        for t in tags(l):
            if t.startswith("fb") and t[2:].isdigit():
                c_anuncio[t[2:]] += 1

        if l["status_id"] == 143:
            c_motivo[motivo_perda(l) or "(sem motivo informado)"] += 1

    # ranking de vendedores com ganho e receita juntos
    vendedores = []
    for nome, qtd in c_vendedor.most_common(15):
        if nome == "(nao preenchido)":
            continue
        vendedores.append({
            "nome": nome,
            "leads": qtd,
            "ganhos": c_vendedor_ganho.get(nome, 0),
            "receita": v_vendedor_receita.get(nome, 0),
            "conversao": round(100 * c_vendedor_ganho.get(nome, 0) / qtd, 1) if qtd else 0,
        })

    # leads abertos parados ha mais de 7 dias
    corte = int(time.time()) - 7 * 86400
    estagnados = sum(1 for l in abertos if (l.get("updated_at") or 0) < corte)

    return {
        "total": total,
        "ganhos": len(ganhos),
        "perdidos": len(perdidos),
        "abertos": len(abertos),
        "estagnados": estagnados,
        "receita": receita,
        "ticket_medio": round(receita / len(ganhos), 2) if ganhos else 0,
        "taxa_conversao": round(100 * len(ganhos) / total, 2) if total else 0,
        "taxa_perda": round(100 * len(perdidos) / total, 2) if total else 0,
        "funil": etapas,
        "perda_por_etapa": top(perda_etapa, 10, rotulo_vazio=True),
        "vendedores": vendedores,
        "modelos": top(c_modelo, 10),
        "unidades": top(c_unidade, 5),
        "setores": top(c_setor, 8),
        "motivos_perda": top(c_motivo, 8, rotulo_vazio=True),
        "campanhas": top(c_campanha, 10),
        "origens": top(c_origem, 8, rotulo_vazio=True),
        "anuncios": [{"ad_id": k, "valor": v} for k, v in c_anuncio.most_common(15)],
        "preenchimento": {
            "utm_campaign": total - c_campanha.get("(nao preenchido)", 0),
            "vendedor": total - c_vendedor.get("(nao preenchido)", 0),
            "modelo": total - c_modelo.get("(nao preenchido)", 0),
            "unidade": total - c_unidade.get("(nao preenchido)", 0),
            "motivo_perda": len(perdidos) - c_motivo.get("(sem motivo informado)", 0),
        },
    }


def serie_diaria(leads):
    dias = collections.defaultdict(lambda: {"leads": 0, "ganhos": 0, "perdidos": 0, "receita": 0})
    for l in leads:
        d = datetime.fromtimestamp(l["created_at"], BRT).strftime("%Y-%m-%d")
        dias[d]["leads"] += 1
        if l["status_id"] == 142:
            dias[d]["ganhos"] += 1
            dias[d]["receita"] += l.get("price") or 0
        elif l["status_id"] == 143:
            dias[d]["perdidos"] += 1
    return [{"data": k, **v} for k, v in sorted(dias.items())]


def main():
    if not TOKEN:
        raise SystemExit("ERRO: variavel de ambiente KOMMO_TOKEN nao definida.")

    agora = datetime.now(BRT)
    desde = int((agora - timedelta(days=DIAS_HISTORICO)).timestamp())

    print(f"Baixando leads criados nos ultimos {DIAS_HISTORICO} dias...")
    leads = baixar_leads(desde)
    print(f"Total: {len(leads)} leads")

    # o funil so precisa de historico do maior periodo exibido (90 dias)
    print("Baixando historico de mudancas de status (90 dias)...")
    hist, pipes = baixar_historico(int((agora - timedelta(days=90)).timestamp()))
    print(f"Historico: {len(hist)} leads com mudanca de etapa registrada")

    # Os cortes sao alinhados ao inicio do dia (BRT) e "N dias" inclui hoje,
    # exatamente como recorteSerie() faz no front — senao o total do periodo
    # nao bate com a soma da serie diaria no mesmo periodo.
    def inicio_do_dia(d):
        return d.replace(hour=0, minute=0, second=0, microsecond=0)

    periodos = {
        "7d": int(inicio_do_dia(agora - timedelta(days=6)).timestamp()),
        "30d": int(inicio_do_dia(agora - timedelta(days=29)).timestamp()),
        "90d": int(inicio_do_dia(agora - timedelta(days=89)).timestamp()),
        "mes": int(inicio_do_dia(agora.replace(day=1)).timestamp()),
    }

    saida = {
        "atualizado_em": agora.strftime("%d/%m/%Y %H:%M"),
        "dias_historico": DIAS_HISTORICO,
        "pipelines": {},
    }

    for pid, chave in PIPELINES.items():
        # Um lead pertence ao funil se esta nele agora OU se ja esteve.
        # Sem isso, o lead que foi encaminhado e depois movido para Nutricao
        # sumia das etapas por onde comprovadamente passou.
        do_pipe = [l for l in leads
                   if l.get("pipeline_id") == pid or pid in pipes.get(l["id"], ())]
        bloco = {
            "id": pid,
            "serie": serie_diaria(do_pipe),
            "periodos": {},
        }
        for nome, ts in periodos.items():
            recorte = [l for l in do_pipe if l["created_at"] >= ts]
            bloco["periodos"][nome] = agrega_periodo(recorte, FUNIL[chave], hist)
        saida["pipelines"][chave] = bloco
        p30 = bloco["periodos"]["30d"]
        print(f"  {chave}: {len(do_pipe)} leads ({DIAS_HISTORICO}d) | "
              f"30d: {p30['total']} leads, {p30['ganhos']} ganhos, R$ {p30['receita']:,.0f}")

    os.makedirs("data", exist_ok=True)
    with open("data/kommo.json", "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, separators=(",", ":"))

    tam = os.path.getsize("data/kommo.json") / 1024
    print(f"OK -> data/kommo.json ({tam:.0f} KB, sem PII)")


if __name__ == "__main__":
    main()
