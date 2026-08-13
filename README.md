# Dashboard Taiyo Honda — Mídia + CRM

Painel estático que cruza investimento do **Meta Ads** com o funil do **Kommo CRM**,
separado em duas áreas: **Veículos Novos** e **Pós-Vendas**. Cada área tem uma aba
**Comercial** e uma aba **Mídia**.

## Como funciona

Não há backend. Dois scripts Python consultam as APIs, gravam JSON agregado em
`data/`, e um GitHub Action commita o resultado 2× por dia. As páginas HTML só leem
esses arquivos.

```
fetch_kommo.py  ──►  data/kommo.json  ──┐
                                        ├──►  index.html · novos.html · posvendas.html
fetch_meta.py   ──►  data/meta.json   ──┘
```

### Privacidade

O repositório é público, então **os arquivos em `data/` contêm apenas números
agregados** — contagens, somas e médias. Nenhum nome, telefone, e-mail ou ID de
contato de lead é publicado. Se for alterar os scripts, mantenha essa regra.

## Rodando local

```bash
cp .env.example .env      # preencha os tokens
set -a && source .env && set +a
python3 fetch_kommo.py
python3 fetch_meta.py
python3 -m http.server 8899
```

Abra <http://localhost:8899>. Precisa de um servidor: o navegador bloqueia `fetch`
em `file://`.

## Secrets do GitHub Actions

Em **Settings → Secrets and variables → Actions**:

| Secret | Valor |
|---|---|
| `KOMMO_SUBDOMAIN` | `taiyohonda` |
| `KOMMO_TOKEN` | token de longa duração do Kommo |
| `META_TOKEN` | System User token do BM "Negócios Taiyo" com `ads_read` |
| `META_ACCOUNT_NOVOS` | `act_1667526963623142` |
| `META_ACCOUNT_POSVENDAS` | `act_858960833896053` |

Sem `META_TOKEN` o `fetch_meta.py` apenas avisa e sai — a coleta do CRM continua
funcionando e as abas de Mídia mostram um aviso de "aguardando conexão".

## Fontes e IDs

**Kommo** — conta `taiyohonda` (35792411). Funis usados:

| Funil | ID | Uso |
|---|---|---|
| Novos | 12760795 | página Novos |
| Pós-venda | 13274704 | página Pós-Vendas |
| Nutrição | 12768987 | só no card de pendências do Início |
| Seminovos | 13636676 | coletado, ainda sem página |

**Meta Ads** — BM "Negócios Taiyo" (118780010629826):
`act_1667526963623142` (Novos) e `act_858960833896053` (Pós-vendas).

## Como o funil é calculado

O funil **não** usa só o status atual do lead. Se usasse, um lead perdido na etapa 2
sumiria da contagem das etapas 1 e 2, e o topo do funil ficaria menor que o total de
leads recebidos. `fetch_kommo.py` baixa o histórico de `lead_status_changed` dos
últimos 90 dias e calcula, por lead, a **etapa mais avançada que ele alcançou** —
o que também alimenta o quadro "Onde os leads se perdem".

## Limitações conhecidas dos dados

Estão listadas no próprio dashboard, no bloco "O que precisa de atenção" do Início:

1. **UTMs não chegam ao Kommo.** Os campos `utm_source`/`utm_campaign` existem mas
   vêm vazios em quase todos os leads, então não dá para atribuir lead → campanha.
   Os leads de clique-para-WhatsApp são recuperados pela tag `fb<ad_id>`.
2. **Venda de veículo novo não é fechada no Kommo.** O funil Novos praticamente não
   registra "Ganho", então receita, ticket e CAC dessa área ficam sem base.
3. **Motivo de perda quase sempre vazio.**
4. **"Modelo de interesse" é campo livre** — o script normaliza a grafia
   (HR-V / hr-v / hrv viram um só), mas o ideal é virar campo de seleção.
