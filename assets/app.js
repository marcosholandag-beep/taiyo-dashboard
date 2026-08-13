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

/**
 * Recorta a serie diaria. "N dias" inclui hoje e os N-1 anteriores — o mesmo
 * corte que fetch_kommo.py aplica, para o total do periodo bater com a soma
 * da serie.
 */
function recorteSerie(serie, periodo) {
  if (!serie || !serie.length) return [];
  const hoje = new Date();
  let corte;
  if (periodo === 'mes') {
    corte = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  } else {
    const dias = parseInt(periodo, 10) || 30;
    corte = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - (dias - 1));
  }
  const iso = isoLocal(corte);
  return serie.filter(p => (p.data || '') >= iso);
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

function iniciarPeriodo(aoTrocar) {
  const barra = document.querySelector('.filtros');
  if (!barra) return;
  barra.addEventListener('click', ev => {
    const c = ev.target.closest('.chip');
    if (!c) return;
    barra.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', String(x === c)));
    aoTrocar(c.dataset.periodo);
  });
}

const ROTULO_PERIODO = { '7d': 'últimos 7 dias', '30d': 'últimos 30 dias', '90d': 'últimos 90 dias', 'mes': 'mês corrente' };
