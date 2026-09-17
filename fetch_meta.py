#!/usr/bin/env python3
"""
Puxa insights do Meta Ads (contas Taiyo Novos e Pos-vendas) -> data/meta.json.

Precisa de META_TOKEN com escopo ads_read nas duas contas.
O ideal e um System User token do BM "Negocios Taiyo" (nao expira).
"""
import os
import json
import time
import urllib.request
import urllib.error
import urllib.parse
import collections
from datetime import datetime, timedelta, timezone

TOKEN = os.environ.get("META_TOKEN", "")
API = "https://graph.facebook.com/v21.0"
BRT = timezone(timedelta(hours=-3))

CONTAS = {
    "novos": os.environ.get("META_ACCOUNT_NOVOS", "act_1667526963623142"),
    "posvendas": os.environ.get("META_ACCOUNT_POSVENDAS", "act_858960833896053"),
    "seminovos": os.environ.get("META_ACCOUNT_SEMINOVOS", "act_1227886575905312"),
}

# acoes que contam como "resultado" para a Taiyo (CTWA + formulario)
# So `lead` para formulario: a API devolve o MESMO lead tambem como
# onsite_conversion.lead_grouped (e variantes offsite_*_add_meta_leads). Somar
# os dois dobrava os leads de formulario.
ACOES_LEAD = {
    "onsite_conversion.messaging_conversation_started_7d": "conversas",
    "lead": "leads_form",
}

# O que conta como resultado em cada conta. Novos mede so formulario (lead);
# as demais somam conversa iniciada no WhatsApp e formulario.
ACOES_POR_CONTA = {
    "novos": {"lead": "leads_form"},
}
METRICA_POR_CONTA = {"novos": "leads"}

CAMPOS = ",".join([
    "campaign_id", "campaign_name", "adset_name", "ad_id", "ad_name",
    "spend", "impressions", "reach", "clicks", "ctr", "cpc", "cpm",
    "frequency", "actions", "cost_per_action_type", "objective",
])


# Codigos de erro do Meta que passam com o tempo: limite de chamadas (4, 17,
# 32, 613, 80000-80014) e indisponibilidade temporaria (1, 2). Chegam como
# HTTP 400/403, nao 429, entao o status HTTP sozinho nao serve para decidir.
ERROS_PASSAGEIROS = {1, 2, 4, 17, 32, 341, 613} | set(range(80000, 80015))


def http_get(url, tentativas=6):
    for i in range(tentativas):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            corpo = e.read().decode("utf-8", "replace")
            try:
                erro = json.loads(corpo).get("error", {})
            except ValueError:
                erro = {}
            passageiro = (e.code in (429, 500, 502, 503)
                          or erro.get("code") in ERROS_PASSAGEIROS
                          or erro.get("is_transient"))
            if passageiro and i < tentativas - 1:
                espera = 30 * (2 ** i)          # 30s, 1min, 2min, 4min, 8min
                print(f"    [aguardando {espera}s] Meta: {erro.get('message', e.code)}")
                time.sleep(espera)
                continue
            raise RuntimeError(f"Meta API {e.code}: {corpo[:400]}")
        except (urllib.error.URLError, TimeoutError):
            if i < tentativas - 1:
                time.sleep(3 * (i + 1))
                continue
            raise
    return {}


def insights(conta, nivel, desde, ate, time_increment=None, limite=500):
    """Retorna lista de linhas de insights, seguindo paginacao."""
    params = {
        "access_token": TOKEN,
        "level": nivel,
        "fields": CAMPOS,
        "time_range": json.dumps({"since": desde, "until": ate}),
        "limit": limite,
        "action_attribution_windows": json.dumps(["7d_click", "1d_view"]),
    }
    if time_increment:
        params["time_increment"] = time_increment
    url = f"{API}/{conta}/insights?" + urllib.parse.urlencode(params)

    linhas = []
    while url:
        d = http_get(url)
        linhas.extend(d.get("data", []))
        url = (d.get("paging") or {}).get("next")
        if len(linhas) > 20000:
            break
    return linhas


def extrai_acoes(linha, acoes=ACOES_LEAD):
    """Soma conversas iniciadas e leads de formulario de uma linha de insights."""
    out = {"conversas": 0, "leads_form": 0}
    for a in (linha.get("actions") or []):
        alvo = acoes.get(a.get("action_type"))
        if alvo:
            try:
                out[alvo] += int(float(a.get("value", 0)))
            except (TypeError, ValueError):
                pass
    return out


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def resume(linhas, acoes=ACOES_LEAD):
    """Agrega uma lista de linhas de insights em um bloco de KPIs."""
    gasto = sum(num(l.get("spend")) for l in linhas)
    impressoes = sum(num(l.get("impressions")) for l in linhas)
    alcance = sum(num(l.get("reach")) for l in linhas)
    cliques = sum(num(l.get("clicks")) for l in linhas)
    conversas = leads_form = 0
    for l in linhas:
        a = extrai_acoes(l, acoes)
        conversas += a["conversas"]
        leads_form += a["leads_form"]
    resultados = conversas + leads_form
    return {
        "gasto": round(gasto, 2),
        "impressoes": int(impressoes),
        "alcance": int(alcance),
        "cliques": int(cliques),
        "conversas": conversas,
        "leads_form": leads_form,
        "resultados": resultados,
        "ctr": round(100 * cliques / impressoes, 2) if impressoes else 0,
        "cpc": round(gasto / cliques, 2) if cliques else 0,
        "cpm": round(1000 * gasto / impressoes, 2) if impressoes else 0,
        "cpr": round(gasto / resultados, 2) if resultados else 0,
    }


def ranking(linhas, chave_id, chave_nome, n=12, acoes=ACOES_LEAD):
    grupos = collections.defaultdict(list)
    for l in linhas:
        grupos[(l.get(chave_id), l.get(chave_nome))].append(l)
    itens = []
    for (ident, nome), ls in grupos.items():
        r = resume(ls, acoes)
        if r["gasto"] <= 0:
            continue
        r["id"] = ident
        r["nome"] = nome or "(sem nome)"
        itens.append(r)
    itens.sort(key=lambda x: -x["gasto"])
    return itens[:n]


def thumbs(ad_ids):
    """
    Miniatura e imagem grande de cada criativo.

    Devolve {ad_id: (miniatura, previa)} — a miniatura vai na tabela e a previa
    aparece ao passar o mouse. O thumbnail_url e pedido em 600x600 para a previa
    nao sair borrada.

    Uma chamada por anuncio: o parametro `ids` em lote foi descontinuado na
    v26+ e a Graph API recusa mesmo quando a URL pede uma versao anterior.
    """
    out = {}
    for ad_id in [i for i in ad_ids if i]:
        try:
            d = http_get(f"{API}/{ad_id}?" + urllib.parse.urlencode({
                "access_token": TOKEN,
                "fields": "creative{id,thumbnail_url,image_url}",
            }))
        except RuntimeError:
            continue
        cr = (d or {}).get("creative") or {}
        mini = cr.get("thumbnail_url") or cr.get("image_url")
        if not mini:
            continue

        # A imagem grande: para anuncio de imagem o image_url ja e grande; para
        # video so existe o thumbnail, e o parametro de tamanho so funciona no
        # no do CRIATIVO (no do anuncio ele e ignorado e volta 64x64).
        grande = cr.get("image_url")
        if not grande and cr.get("id"):
            try:
                d2 = http_get(f"{API}/{cr['id']}?" + urllib.parse.urlencode({
                    "access_token": TOKEN,
                    "fields": "thumbnail_url",
                    "thumbnail_width": 600,
                    "thumbnail_height": 600,
                }))
                grande = (d2 or {}).get("thumbnail_url")
            except RuntimeError:
                pass
        out[ad_id] = (mini, grande or mini)
    return out


def main():
    if not TOKEN:
        print("[aviso] META_TOKEN nao definido — data/meta.json nao sera atualizado.")
        return

    agora = datetime.now(BRT)
    hoje = agora.strftime("%Y-%m-%d")
    # "N dias" = hoje e os N-1 anteriores, igual ao corte do CRM no navegador.
    # Antes era hoje-N, que cobria N+1 dias e deixava o CPL com gasto de 8 dias
    # dividido por leads de 7.
    janelas = {
        "7d": (agora - timedelta(days=6)).strftime("%Y-%m-%d"),
        "30d": (agora - timedelta(days=29)).strftime("%Y-%m-%d"),
        "90d": (agora - timedelta(days=89)).strftime("%Y-%m-%d"),
        "mes": agora.replace(day=1).strftime("%Y-%m-%d"),
    }
    inicio_serie = (agora - timedelta(days=180)).strftime("%Y-%m-%d")

    saida = {
        "atualizado_em": agora.strftime("%d/%m/%Y %H:%M"),
        "fonte": "api",
        "contas": {},
    }

    # Coleta anterior: se uma conta falhar, ela e mantida inteira em vez de
    # ser sobrescrita por um bloco pela metade.
    try:
        with open("data/meta.json", encoding="utf-8") as f:
            anterior = json.load(f).get("contas", {})
    except (OSError, ValueError):
        anterior = {}

    for chave, conta in CONTAS.items():
        print(f"Conta {chave} ({conta})...")
        acoes = ACOES_POR_CONTA.get(chave, ACOES_LEAD)
        bloco = {"id": conta, "periodos": {}, "serie": [], "erro": None,
                 "metrica": METRICA_POR_CONTA.get(chave, "resultados")}
        try:
            # serie diaria (180d, nivel conta)
            diario = insights(conta, "account", inicio_serie, hoje, time_increment="1")
            serie = []
            for l in diario:
                a = extrai_acoes(l, acoes)
                serie.append({
                    "data": l.get("date_start"),
                    "gasto": round(num(l.get("spend")), 2),
                    "impressoes": int(num(l.get("impressions"))),
                    "cliques": int(num(l.get("clicks"))),
                    "resultados": a["conversas"] + a["leads_form"],
                })
            bloco["serie"] = sorted(serie, key=lambda x: x["data"] or "")

            for nome, desde in janelas.items():
                camp = insights(conta, "campaign", desde, hoje)
                ads = insights(conta, "ad", desde, hoje)
                # KPIs do periodo vem do nivel CONTA. Somar campanhas inflava o
                # alcance (a mesma pessoa conta em varias campanhas) e perdia o
                # gasto de campanhas excluidas.
                p = resume(insights(conta, "account", desde, hoje), acoes)
                p["campanhas"] = ranking(camp, "campaign_id", "campaign_name", acoes=acoes)
                p["anuncios"] = ranking(ads, "ad_id", "ad_name", n=12, acoes=acoes)
                bloco["periodos"][nome] = p
                print(f"  {nome}: R$ {p['gasto']:,.2f} | {p['resultados']} resultados | CPR R$ {p['cpr']:,.2f}")

            # Um mapa unico de criativos por conta, cobrindo os anuncios de
            # TODOS os periodos. Antes as imagens ficavam so dentro do bloco de
            # 30 dias, entao mudar o filtro fazia as miniaturas sumirem.
            ids = []
            for per in bloco["periodos"].values():
                for a in per["anuncios"]:
                    if a["id"] not in ids:
                        ids.append(a["id"])
            bloco["criativos"] = {
                ad: {"thumb": par[0], "previa": par[1]}
                for ad, par in thumbs(ids).items()
            }

        except Exception as e:  # noqa: BLE001 — uma conta nao pode derrubar a outra
            print(f"  [erro] {e}")
            completo = all(k in (anterior.get(chave, {}).get("periodos") or {})
                           for k in janelas)
            if completo:
                bloco = anterior[chave]
                print("  mantendo a coleta anterior desta conta")
            else:
                bloco["erro"] = str(e)[:300]

        saida["contas"][chave] = bloco

    os.makedirs("data", exist_ok=True)
    with open("data/meta.json", "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, separators=(",", ":"))
    print(f"OK -> data/meta.json ({os.path.getsize('data/meta.json')/1024:.0f} KB)")


if __name__ == "__main__":
    main()
