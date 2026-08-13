/* ==========================================================================
   Taiyo Honda — helpers compartilhados do dashboard
   ========================================================================== */

/* ---------- formatacao ---------- */
const fmt = {
  int: n => (n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 }),
  moeda: n => 'R$ ' + (n ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  moedaCurta: n => {
    const v = n ?? 0;
    if (Math.abs(v) >= 1000000) return 'R$ ' + (v / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
    if (Math.abs(v) >= 1000) return 'R$ ' + (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
    return 'R$ ' + v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  },
  pct: n => (n ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%',
  data: s => {
    if (!s) return '';
    const [a, m, d] = s.split('-');
    return `${d}/${m}`;
  },
};

/* ---------- paleta (lida do CSS, acompanha o tema) ---------- */
function cor(nome) {
  return getComputedStyle(document.documentElement).getPropertyValue('--' + nome).trim();
}
const ORDINAL = i => cor('ord-' + Math.min(10, i + 1));

/* ---------- tema ---------- */
// O dashboard e claro por definicao (IDV Trilha). Mantido como no-op para as
// paginas que ainda chamam iniciarTema() no boot.
function iniciarTema() {}

/* ---------- Chart.js: padroes ---------- */
function padroesChart() {
  if (!window.Chart) return;
  Chart.defaults.font.family = "'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = cor('text-muted');
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation.duration = 400;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.boxHeight = 8;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.tooltip.backgroundColor = cor('text-primary');
  Chart.defaults.plugins.tooltip.titleColor = cor('surface-1');
  Chart.defaults.plugins.tooltip.bodyColor = cor('surface-1');
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 7;
  Chart.defaults.plugins.tooltip.displayColors = true;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
}

const eixoY = (extras = {}) => ({
  beginAtZero: true,
  border: { display: false },
  grid: { color: cor('gridline'), drawTicks: false },
  ticks: { padding: 8, maxTicksLimit: 6 },
  ...extras,
});

const eixoX = (extras = {}) => ({
  border: { color: cor('baseline') },
  grid: { display: false },
  ticks: { padding: 6, maxRotation: 0, autoSkipPadding: 14 },
  ...extras,
});

/* registro para redesenhar quando o tema muda */
const graficos = new Map();
function desenhar(id, construir) {
  const el = document.getElementById(id);
  if (!el) return;
  if (graficos.has(id)) { graficos.get(id).destroy(); graficos.delete(id); }
  padroesChart();
  const g = construir(el.getContext('2d'));
  if (g) graficos.set(id, g);
}
document.addEventListener('tema-mudou', () => {
  setTimeout(() => document.dispatchEvent(new CustomEvent('redesenhar')), 30);
});

/* ---------- blocos de UI ---------- */
function kpi({ rotulo, valor, nota, tom }) {
  const cls = tom ? ` ${tom}` : '';
  return `<div class="kpi">
    <div class="kpi-rotulo">${rotulo}</div>
    <div class="kpi-valor">${valor}</div>
    ${nota ? `<div class="kpi-nota${cls}">${nota}</div>` : ''}
  </div>`;
}

function vazio(msg) {
  return `<div class="vazio">${msg}</div>`;
}

/**
 * Funil como piramide invertida.
 *
 * Cada etapa e um trapezio cuja largura no topo e a da etapa anterior e na
 * base e a da propria etapa, entao o estreitamento desenha a perda. Desenhado
 * em SVG (trapezio nao sai de um <div>), com nome a esquerda e numero a
 * direita em colunas HTML alinhadas pela mesma altura de linha.
 */
function renderFunil(el, etapas) {
  if (!el) return;

  const ALT = 46;          // altura de cada faixa
  const VAO = 3;           // respiro entre faixas
  const L = 300;           // largura do viewBox
  const MIN = 26;          // largura minima para a faixa nao sumir
  const base = Math.max(...etapas.map(e => e.alcancaram), 1);

  const larg = v => Math.max(MIN, L * (v / base));
  const alturaTotal = etapas.length * ALT;

  const faixas = etapas.map((e, i) => {
    const topo = i === 0 ? L : larg(etapas[i - 1].alcancaram);
    const baixo = larg(e.alcancaram);
    const y = i * ALT;
    const y2 = y + ALT - VAO;
    const p = [
      [(L - topo) / 2, y], [(L + topo) / 2, y],
      [(L + baixo) / 2, y2], [(L - baixo) / 2, y2],
    ].map(c => c.join(',')).join(' ');
    return `<polygon points="${p}" fill="${ORDINAL(i)}"></polygon>`;
  }).join('');

  const nomes = etapas.map(e =>
    `<div class="funil-cel funil-nome" style="height:${ALT}px">${e.nome}</div>`).join('');

  // A direita fica a taxa de passagem: quantos % da etapa anterior chegaram
  // aqui. E a leitura neutra — mede avanco, nao perda.
  const nums = etapas.map((e, i) => {
    const ant = i > 0 ? etapas[i - 1].alcancaram : 0;
    const passou = i > 0 && ant > 0 ? 100 * e.alcancaram / ant : null;
    return `<div class="funil-cel funil-num" style="height:${ALT}px">
      <b>${fmt.int(e.alcancaram)}</b>
      ${passou !== null ? `<span class="funil-taxa">${passou.toFixed(0)}%</span>` : ''}
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="funil-grade">
      <div class="funil-col">${nomes}</div>
      <svg class="funil-svg" viewBox="0 0 ${L} ${alturaTotal}"
           preserveAspectRatio="none" height="${alturaTotal}" aria-hidden="true">${faixas}</svg>
      <div class="funil-col">${nums}</div>
    </div>`;
}

/** Tabela simples a partir de colunas declaradas. */
function renderTabela(el, linhas, colunas, msgVazio = 'Sem dados no período.') {
  if (!el) return;
  if (!linhas || !linhas.length) { el.innerHTML = `<p class="vazio">${msgVazio}</p>`; return; }
  el.innerHTML = `<div class="tabela-wrap"><table>
    <thead><tr>${colunas.map(c => `<th>${c.titulo}</th>`).join('')}</tr></thead>
    <tbody>${linhas.map(l => `<tr>${colunas.map(c => `<td>${c.valor(l)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

/* ---------- carregamento ---------- */
async function carregarJSON(caminho) {
  try {
    const r = await fetch(caminho + '?v=' + Date.now());
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    console.warn('Falha ao carregar', caminho, e);
    return null;
  }
}

/** Data local em YYYY-MM-DD (toISOString converteria para UTC e puxaria o dia). */
function isoLocal(d) {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}


/* ==========================================================================
   Agregacao no navegador

   data/kommo.json traz um registro por lead (sem PII). Todo numero da tela sai
   daqui, para qualquer intervalo de datas — inclusive personalizado.

   Campos do registro:
     0 d dia   1 s estado(0 aberto,1 ganho,2 perdido)   2 a etapa maxima
     3 t bitmask de tags de etapa   4 m modelo   5 u unidade   6 r motivo
     7 o origem   8 p valor   9 utm   10 e estagnado
   ========================================================================== */

const R = { DIA: 0, EST: 1, AVANCO: 2, TAGS: 3, MODELO: 4, UNIDADE: 5, MOTIVO: 6, ORIGEM: 7, VALOR: 8, UTM: 9, PARADO: 10 };

/** Converte "YYYY-MM-DD" no indice de dia usado nos registros. */
function diaDe(iso, inicioISO) {
  const [a, m, d] = iso.split('-').map(Number);
  const [a0, m0, d0] = inicioISO.split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(a0, m0 - 1, d0)) / 86400000);
}

function contarTop(mapa, dicionario, n, incluirVazio) {
  const saida = [];
  mapa.forEach((v, k) => {
    if (k < 0) { if (incluirVazio) saida.push({ nome: '(não preenchido)', valor: v }); return; }
    saida.push({ nome: dicionario[k], valor: v });
  });
  saida.sort((x, y) => y.valor - x.valor);
  return saida.slice(0, n);
}

/** Agrega os leads de um funil dentro do intervalo [d0, d1] (indices de dia). */
function agregar(regs, etapas, dic, d0, d1) {
  const dentro = regs.filter(r => r[R.DIA] >= d0 && r[R.DIA] <= d1);

  let ganhos = 0, perdidos = 0, receita = 0, estagnados = 0, comUtm = 0;
  const cModelo = new Map(), cUnidade = new Map(), cMotivo = new Map(),
        cOrigem = new Map(), cPerdaEtapa = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const r of dentro) {
    if (r[R.EST] === 1) { ganhos++; receita += r[R.VALOR]; }
    else if (r[R.EST] === 2) {
      perdidos++;
      inc(cMotivo, r[R.MOTIVO]);
      inc(cPerdaEtapa, r[R.AVANCO]);
    }
    if (r[R.PARADO]) estagnados++;
    if (r[R.UTM]) comUtm++;
    inc(cModelo, r[R.MODELO]);
    inc(cUnidade, r[R.UNIDADE]);
    inc(cOrigem, r[R.ORIGEM]);
  }

  const total = dentro.length;
  const abertos = total - ganhos - perdidos;

  // funil: etapa com tag conta pela tag; as demais, pela etapa maxima alcancada
  const funil = etapas.map((et, i) => {
    const ultima = i === etapas.length - 1;
    let alcancaram;
    if (ultima) alcancaram = ganhos;
    else if (et.tag) alcancaram = dentro.reduce((s, r) => s + ((r[R.TAGS] >> i) & 1), 0);
    else alcancaram = dentro.reduce((s, r) => s + (r[R.AVANCO] >= i ? 1 : 0), 0);
    return { nome: et.nome, alcancaram, fonte: et.tag ? 'tag' : 'status' };
  });
  // um funil nunca cresce de uma etapa para a seguinte
  for (let i = funil.length - 2; i >= 0; i--) {
    if (funil[i].alcancaram < funil[i + 1].alcancaram) funil[i].alcancaram = funil[i + 1].alcancaram;
  }

  const nomeEtapa = i => (i >= 0 && i < etapas.length ? etapas[i].nome : '(sem etapa registrada)');
  const perdaEtapa = [];
  cPerdaEtapa.forEach((v, k) => perdaEtapa.push({ nome: nomeEtapa(k), valor: v }));
  perdaEtapa.sort((a, b) => b.valor - a.valor);

  return {
    total, ganhos, perdidos, abertos, estagnados, receita,
    ticket_medio: ganhos ? receita / ganhos : 0,
    taxa_conversao: total ? 100 * ganhos / total : 0,
    taxa_perda: total ? 100 * perdidos / total : 0,
    funil,
    perda_por_etapa: perdaEtapa,
    modelos: contarTop(cModelo, dic.modelos, 10, false),
    unidades: contarTop(cUnidade, dic.unidades, 5, false),
    motivos_perda: contarTop(cMotivo, dic.motivos, 8, true),
    origens: contarTop(cOrigem, dic.origens, 8, true),
    preenchimento: {
      utm_campaign: comUtm,
      modelo: total - (cModelo.get(-1) || 0),
      unidade: total - (cUnidade.get(-1) || 0),
      motivo_perda: perdidos - (cMotivo.get(-1) || 0),
    },
  };
}

/** Serie diaria de leads/ganhos/receita, para os graficos de linha. */
function serieDiaria(regs, inicioISO, d0, d1) {
  const base = new Date(inicioISO + 'T00:00:00');
  const balde = new Map();
  for (let d = d0; d <= d1; d++) balde.set(d, { leads: 0, ganhos: 0, receita: 0 });
  for (const r of regs) {
    const b = balde.get(r[R.DIA]);
    if (!b) continue;
    b.leads++;
    if (r[R.EST] === 1) { b.ganhos++; b.receita += r[R.VALOR]; }
  }
  return [...balde.entries()].map(([d, v]) => {
    const dt = new Date(base.getTime() + d * 86400000);
    return { data: isoLocal(dt), ...v };
  });
}

/** Intervalo [d0, d1] a partir do periodo escolhido. */
function intervalo(periodo, inicioISO, personalizado) {
  const hoje = new Date();
  const hojeIdx = diaDe(isoLocal(hoje), inicioISO);
  if (periodo === 'custom' && personalizado?.de && personalizado?.ate) {
    return [diaDe(personalizado.de, inicioISO), diaDe(personalizado.ate, inicioISO)];
  }
  if (periodo === 'mes') {
    const p = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    return [diaDe(isoLocal(p), inicioISO), hojeIdx];
  }
  const dias = parseInt(periodo, 10) || 30;
  return [hojeIdx - (dias - 1), hojeIdx];
}

/** Data ISO a partir do indice de dia. */
function isoDoDia(d, inicioISO) {
  const base = new Date(inicioISO + 'T00:00:00');
  return isoLocal(new Date(base.getTime() + d * 86400000));
}

const ROTULO_PERIODO = {
  '7d': 'últimos 7 dias', '30d': 'últimos 30 dias',
  '90d': 'últimos 90 dias', 'mes': 'mês corrente',
};

function rotuloPeriodo(periodo, custom) {
  if (periodo === 'custom' && custom?.de && custom?.ate) {
    const br = s => s.split('-').reverse().join('/');
    return `${br(custom.de)} a ${br(custom.ate)}`;
  }
  return ROTULO_PERIODO[periodo] || periodo;
}

/** Recorta a serie diaria do Meta ao intervalo pedido. */
function recorteMeta(serie, inicioISO, d0, d1) {
  if (!serie || !serie.length) return [];
  const de = isoDoDia(d0, inicioISO), ate = isoDoDia(d1, inicioISO);
  return serie.filter(p => p.data >= de && p.data <= ate);
}

/**
 * KPIs de midia para o intervalo.
 *
 * Os presets tem numeros exatos vindos da API. Para intervalo personalizado a
 * soma sai da serie diaria; campanha e anuncio nao tem recorte proprio porque
 * o Meta so entrega esse detalhe em janelas fixas — nesse caso mostramos o
 * detalhe de 30 dias e avisamos na tela.
 */
function midiaDoIntervalo(conta, periodo, inicioISO, d0, d1) {
  if (!conta || !conta.periodos) return null;
  if (periodo !== 'custom') return conta.periodos[periodo] || null;

  const s = recorteMeta(conta.serie, inicioISO, d0, d1);
  if (!s.length) return null;
  const soma = k => s.reduce((a, b) => a + (b[k] || 0), 0);
  const gasto = soma('gasto'), impressoes = soma('impressoes'),
        cliques = soma('cliques'), resultados = soma('resultados');
  const trinta = conta.periodos['30d'] || {};
  return {
    gasto: Math.round(gasto * 100) / 100,
    impressoes, cliques, resultados,
    conversas: resultados, leads_form: 0,
    alcance: 0,
    ctr: impressoes ? Math.round(10000 * cliques / impressoes) / 100 : 0,
    cpc: cliques ? Math.round(100 * gasto / cliques) / 100 : 0,
    cpm: impressoes ? Math.round(100000 * gasto / impressoes) / 100 : 0,
    cpr: resultados ? Math.round(100 * gasto / resultados) / 100 : 0,
    campanhas: trinta.campanhas || [],
    anuncios: trinta.anuncios || [],
    detalheAproximado: true,
  };
}

/* ---------- abas e filtros ---------- */
function iniciarAbas(aoTrocar) {
  document.querySelectorAll('.abas').forEach(barra => {
    barra.addEventListener('click', ev => {
      const b = ev.target.closest('.aba');
      if (!b) return;
      barra.querySelectorAll('.aba').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      document.querySelectorAll('.painel').forEach(p => {
        p.hidden = p.id !== b.dataset.painel;
      });
      if (aoTrocar) aoTrocar(b.dataset.painel);
    });
  });
}

function iniciarPeriodo(aoTrocar, limites) {
  const barra = document.querySelector('.filtros');
  if (!barra) return;
  const caixa = barra.querySelector('.intervalo');
  const de = barra.querySelector('#data-de');
  const ate = barra.querySelector('#data-ate');

  if (de && ate && limites) {
    de.min = ate.min = limites.min;
    de.max = ate.max = limites.max;
    de.value = limites.padraoDe;
    ate.value = limites.max;
  }

  const marcar = alvo => barra.querySelectorAll('.chip').forEach(
    x => x.setAttribute('aria-pressed', String(x === alvo)));

  barra.addEventListener('click', ev => {
    const c = ev.target.closest('.chip');
    if (c) {
      marcar(c);
      if (caixa) caixa.hidden = c.dataset.periodo !== 'custom';
      if (c.dataset.periodo === 'custom') {
        if (de.value && ate.value) aoTrocar('custom', { de: de.value, ate: ate.value });
      } else {
        aoTrocar(c.dataset.periodo, null);
      }
      return;
    }
    if (ev.target.closest('.btn-aplicar')) {
      if (!de.value || !ate.value) return;
      if (de.value > ate.value) { const v = de.value; de.value = ate.value; ate.value = v; }
      aoTrocar('custom', { de: de.value, ate: ate.value });
    }
  });
}

