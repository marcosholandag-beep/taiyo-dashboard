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
    origem = {}          # lead_id -> (timestamp do evento mais antigo, pipeline de origem)
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
            ts = e.get("created_at") or 0
            for campo in ("value_before", "value_after"):
                for v in (e.get(campo) or []):
                    st = (v or {}).get("lead_status") or {}
                    if st.get("id"):
                        hist[lid].add(st["id"])
                    if st.get("pipeline_id"):
                        pipes[lid].add(st["pipeline_id"])
            # o value_before do evento mais antigo aponta onde o lead nasceu
            for v in (e.get("value_before") or []):
                pid = ((v or {}).get("lead_status") or {}).get("pipeline_id")
                if pid and (lid not in origem or ts < origem[lid][0]):
                    origem[lid] = (ts, pid)
        if page % 20 == 0:
            print(f"  historico: {page} paginas, {len(hist)} leads")
        if not ((d.get("_links") or {}).get("next")):
            break
        page += 1
        if page > 400:
            print("  [aviso] limite de 400 paginas de historico atingido")
            break
    return hist, pipes, origem


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




# ---------------------------------------------------------------------------
# Emissao granular
#
# O arquivo publica UM REGISTRO POR LEAD, sem PII, e o navegador agrega o
# periodo que o usuario escolher — inclusive intervalo personalizado. Antes os
# recortes 7/30/90 vinham prontos do Python e nenhum outro intervalo era
# possivel.
#
# Campos do registro, nesta ordem:
#   0 d   dia (inteiro, dias desde `inicio`)
#   1 s   0 = aberto, 1 = ganho, 2 = perdido
#   2 a   indice da etapa mais avancada alcancada (-1 = nenhuma)
#   3 t   bitmask das etapas cuja tag de automacao esta no lead
#   4 m   indice do modelo de interesse (-1 = vazio)
#   5 u   indice da unidade (-1 = vazio)
#   6 r   indice do motivo de perda (-1 = vazio)
#   7 o   indice da origem
#   8 p   valor da venda, 0 se nao ganho
#   9 utm 1 se tem utm_campaign ou o campo Campanha preenchido
#  10 e   1 se esta aberto e sem movimentacao ha mais de 7 dias
# ---------------------------------------------------------------------------

class Dicionario:
    """Interna strings repetidas: o JSON guarda indices, nao o texto todo."""

    def __init__(self):
        self.itens = []
        self._pos = {}

    def idx(self, valor):
        if valor is None:
            return -1
        if valor not in self._pos:
            self._pos[valor] = len(self.itens)
            self.itens.append(valor)
        return self._pos[valor]


def origem_do_lead(lead):
    """utm_source quando existe; senao deduz da tag de anuncio."""
    origem = cf_valor(lead, CF["utm_source"])
    if origem:
        return origem
    ts = tags(lead)
    if any(t.startswith("fb") and t[2:].isdigit() for t in ts):
        return "Meta Ads (CTWA)"
    if any("meta" in t.lower() or "patrocinado" in t.lower() for t in ts):
        return "Meta Ads (tag)"
    if any("reativado" in t.lower() for t in ts):
        return "Reativacao"
    return "(nao identificado)"


def monta_registros(leads, funil_ids, hist, dia_zero, dicts):
    pos = {sid: i for i, sid in enumerate(funil_ids)}
    ultimo = len(funil_ids)
    corte_estagnado = int(time.time()) - 7 * 86400

    # bit de cada etapa que tem tag de automacao
    bits = {i: TAG_ETAPA[sid] for i, sid in enumerate(funil_ids) if sid in TAG_ETAPA}

    regs = []
    for l in leads:
        atual = l["status_id"]

        idx = [pos[s] for s in hist.get(l["id"], ()) if s in pos]
        if atual in pos:
            idx.append(pos[atual])
        elif atual == 142:
            idx.append(ultimo)
        avanco = max(idx) if idx else -1

        marcas = set(tags(l))
        t = 0
        for i, nome_tag in bits.items():
            if nome_tag in marcas:
                t |= (1 << i)

        s = 1 if atual == 142 else (2 if atual == 143 else 0)
        dia = (datetime.fromtimestamp(l["created_at"], BRT).date() - dia_zero).days

        regs.append([
            dia,
            s,
            avanco,
            t,
            dicts["modelos"].idx(normaliza_modelo(cf_valor(l, CF["modelo"]))),
            dicts["unidades"].idx(cf_valor(l, CF["unidade"])),
            dicts["motivos"].idx(motivo_perda(l) if s == 2 else None),
            dicts["origens"].idx(origem_do_lead(l)),
            int(l.get("price") or 0) if s == 1 else 0,
            1 if (cf_valor(l, CF["utm_campaign"]) or cf_valor(l, CF["campanha"])) else 0,
            1 if (s == 0 and (l.get("updated_at") or 0) < corte_estagnado) else 0,
        ])
    return regs


def main():
    if not TOKEN:
        raise SystemExit("ERRO: variavel de ambiente KOMMO_TOKEN nao definida.")

    agora = datetime.now(BRT)
    desde = int((agora - timedelta(days=DIAS_HISTORICO)).timestamp())
    dia_zero = (agora - timedelta(days=DIAS_HISTORICO)).date()

    print(f"Baixando leads criados nos ultimos {DIAS_HISTORICO} dias...")
    leads = baixar_leads(desde)
    print(f"Total: {len(leads)} leads")

    print("Baixando historico de mudancas de status (180 dias)...")
    hist, pipes, origem = baixar_historico(desde)
    print(f"Historico: {len(hist)} leads com mudanca de etapa registrada")

    dicts = {k: Dicionario() for k in ("modelos", "unidades", "motivos", "origens")}

    saida = {
        "atualizado_em": agora.strftime("%d/%m/%Y %H:%M"),
        "inicio": dia_zero.isoformat(),
        "dias_historico": DIAS_HISTORICO,
        "etapas": {},
        "leads": {},
    }

    for pid, chave in PIPELINES.items():
        # Mesma definicao que o CRM usa na tela: leads criados no periodo que
        # estao NESTE funil. Contar tambem quem passou por aqui e hoje esta em
        # Nutricao inflava o numero e nao batia com o que a equipe ve no Kommo.
        do_pipe = [l for l in leads if l.get("pipeline_id") == pid]
        funil_ids = FUNIL[chave]

        saida["etapas"][chave] = [
            {"nome": STATUS_NOMES.get(sid, str(sid)),
             "tag": TAG_ETAPA.get(sid)}
            for sid in funil_ids
        ] + [{"nome": "Ganho", "tag": None}]

        saida["leads"][chave] = monta_registros(do_pipe, funil_ids, hist, dia_zero, dicts)
        print(f"  {chave}: {len(do_pipe)} leads criados neste funil")

    saida["dic"] = {k: d.itens for k, d in dicts.items()}

    os.makedirs("data", exist_ok=True)
    with open("data/kommo.json", "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, separators=(",", ":"))

    tam = os.path.getsize("data/kommo.json") / 1024
    print(f"OK -> data/kommo.json ({tam:.0f} KB, sem PII)")


if __name__ == "__main__":
    main()
