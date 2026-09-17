/* ==========================================================================
   Renderiza uma pagina de area (Novos ou Pos-Vendas): aba Midia + aba Comercial.
   Chamado por novos.html / posvendas.html com a configuracao da area.
   ========================================================================== */

async function montarPagina(cfg) {
  iniciarTema();

  const [kommo, meta, manual] = await Promise.all([
    CRM_ATIVO ? carregarJSON('data/kommo.json') : null,
    carregarJSON('data/meta.json'),
    CRM_ATIVO ? carregarJSON('data/manual.json') : null,
  ]);

  if (!meta || (CRM_ATIVO && !kommo)) {
    document.getElementById('conteudo').innerHTML =
      '<div class="aviso grave"><span class="aviso-icone">⚠</span><div>Não consegui carregar os dados em <b>data/</b>. Se você abriu o arquivo direto do disco, use um servidor local — o navegador bloqueia <code>fetch</code> em <code>file://</code>.</div></div>';
    return;
  }

  if (!CRM_ATIVO) desativarAbaCRM();
  // base dos indices de dia: o CRM quando ativo, senao o primeiro dia de midia
  const base = CRM_ATIVO ? kommo.inicio : inicioMeta(meta);

  const regs = kommo?.leads?.[cfg.pipeline] || [];
  const vendasManuais = manual?.vendas?.[cfg.pipeline] || [];
  const etapas = kommo?.etapas?.[cfg.pipeline] || [];
  const conta = meta?.contas?.[cfg.conta] || null;
  const metaParcial = meta?.fonte !== 'api';
  const rot_m = rotulosMetrica(conta);

  document.querySelectorAll('.js-atualizado').forEach(el => {
    el.textContent = CRM_ATIVO
      ? 'CRM atualizado em ' + kommo.atualizado_em
      : 'Mídia atualizada em ' + meta.atualizado_em;
  });
  avisoDefasagem(kommo, meta);

  let periodo = '30d';
  let custom = null;
  let d0 = 0, d1 = 0;

  function pintar() {
    [d0, d1] = intervalo(periodo, base, custom);
    const rot = rotuloPeriodo(periodo, custom);
    const m = midiaDoIntervalo(conta, periodo, base, d0, d1);

    document.querySelectorAll('.js-periodo').forEach(el => { el.textContent = rot; });

    if (CRM_ATIVO) {
      const p = agregar(regs, etapas, kommo.dic, d0, d1);
      // vendas informadas a mao dentro do intervalo — nunca somadas ao CRM
      const de = isoDoDia(d0, base), ate = isoDoDia(d1, base);
      p.manuais = vendasManuais.filter(v => v.data >= de && v.data <= ate);
      pintarComercial(p, rot);
    }

    pintarMidia(m, rot);
    document.dispatchEvent(new CustomEvent('redesenhar'));
  }

  /* ====================== ABA COMERCIAL ====================== */
  function pintarComercial(p, rot) {
    const semVenda = p.ganhos === 0 && p.total > 0;

    // Areas onde a venda normalmente nao e fechada no Kommo escondem Ganhos e
    // Receita, que sairiam zerados competindo com o card de vendas informadas.
    // Mas se o funil REGISTRAR uma venda no periodo, ela aparece — esconder um
    // ganho real seria pior que mostrar um zero.
    const mostraGanhoCRM = !cfg.vendaForaDoCRM || p.ganhos > 0;

    document.getElementById('kpis-comercial').innerHTML = [
      kpi({ rotulo: 'Leads recebidos', valor: fmt.int(p.total), nota: rot }),
      ...(mostraGanhoCRM ? [
        kpi({
          rotulo: 'Ganhos', valor: fmt.int(p.ganhos),
          nota: p.total ? fmt.pct(p.taxa_conversao) + ' de conversão' : '—',
          tom: p.taxa_conversao >= 20 ? 'bom' : null,
        }),
        kpi({ rotulo: 'Receita', valor: fmt.moedaCurta(p.receita), nota: p.ganhos ? 'ticket ' + fmt.moedaCurta(p.ticket_medio) : '—' }),
      ] : []),
      kpi({ rotulo: 'Perdidos', valor: fmt.int(p.perdidos), nota: fmt.pct(p.taxa_perda) + ' do total', tom: p.taxa_perda > 60 ? 'ruim' : null }),
      kpi({ rotulo: 'Em aberto', valor: fmt.int(p.abertos), nota: 'no funil agora' }),
      kpi({
        rotulo: 'Parados +7 dias', valor: fmt.int(p.estagnados),
        nota: p.abertos ? fmt.pct(100 * p.estagnados / p.abertos) + ' dos abertos' : '—',
        tom: p.abertos && p.estagnados / p.abertos > 0.5 ? 'ruim' : null,
      }),
      ...(p.manuais?.length ? [kpi({
        rotulo: 'Vendas informadas',
        valor: fmt.int(p.manuais.length),
        nota: 'fora do CRM — informado pela equipe',
      })] : (cfg.vendaForaDoCRM && !p.ganhos ? [kpi({
        rotulo: 'Vendas informadas', valor: '0',
        nota: 'nenhuma informada neste período',
      })] : [])),
    ].join('');

    // aviso quando o funil nao registra venda
    const alerta = document.getElementById('alerta-comercial');
    if (semVenda && cfg.avisoSemVenda) {
      alerta.innerHTML = `<div class="aviso grave"><span class="aviso-icone">⚠</span><div>${cfg.avisoSemVenda}</div></div>`;
    } else { alerta.innerHTML = ''; }

    renderFunil(document.getElementById('funil'), p.funil);

    const serie = serieDiaria(regs, kommo.inicio, d0, d1);
    desenhar('g-leads-dia', ctx => new Chart(ctx, {
      type: 'line',
      data: {
        labels: serie.map(d => fmt.data(d.data)),
        datasets: [{
          label: 'Leads recebidos',
          data: serie.map(d => d.leads),
          borderColor: cor('series-1'),
          backgroundColor: 'transparent',
          borderWidth: 2, tension: .3,
          pointRadius: 0, pointHoverRadius: 5,
          pointHoverBackgroundColor: cor('series-1'),
          pointHoverBorderColor: cor('surface-1'), pointHoverBorderWidth: 2,
        }],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false } },
        scales: { x: eixoX(), y: eixoY() },
      },
    }));


    // modelos de interesse — o canvas fica sempre no DOM; a mensagem de vazio
    // vai num irmao, senao trocar de periodo nao acha mais o canvas.
    const mods = p.modelos.slice(0, 8);
    const semMods = document.getElementById('sem-modelos');
    const telaMods = document.getElementById('g-modelos').parentElement;
    semMods.hidden = mods.length > 0;
    telaMods.hidden = mods.length === 0;
    if (mods.length) {
      desenhar('g-modelos', ctx => new Chart(ctx, {
        type: 'bar',
        data: {
          labels: mods.map(x => x.nome),
          datasets: [{
            label: 'Leads', data: mods.map(x => x.valor),
            backgroundColor: cor('series-1'), borderRadius: 4, borderSkipped: 'start',
            maxBarThickness: 22,
          }],
        },
        options: {
          indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: { x: eixoY(), y: eixoX({ grid: { display: false } }) },
        },
      }));
    }

    // onde os leads se perdem (etapa mais avancada antes da perda)
    renderTabela(document.getElementById('t-perda-etapa'), p.perda_por_etapa.slice(0, 8), [
      { titulo: 'Última etapa antes de perder', valor: l => l.nome },
      { titulo: 'Leads', valor: l => fmt.int(l.valor) },
      { titulo: '% dos perdidos', valor: l => p.perdidos ? fmt.pct(100 * l.valor / p.perdidos) : '—' },
    ], 'Nenhum lead perdido no período.');

    // motivos de perda
    const mot = p.motivos_perda.slice(0, 6);
    renderTabela(document.getElementById('t-motivos'), mot, [
      { titulo: 'Motivo da perda', valor: l => l.nome },
      { titulo: 'Leads', valor: l => fmt.int(l.valor) },
      { titulo: '% dos perdidos', valor: l => p.perdidos ? fmt.pct(100 * l.valor / p.perdidos) : '—' },
    ]);

    // origem
    const org = p.origens.slice(0, 6);
    renderTabela(document.getElementById('t-origens'), org, [
      { titulo: 'Origem identificada', valor: l => l.nome },
      { titulo: 'Leads', valor: l => fmt.int(l.valor) },
      { titulo: '% do total', valor: l => p.total ? fmt.pct(100 * l.valor / p.total) : '—' },
    ]);

    // qualidade de preenchimento do CRM
    const pr = p.preenchimento;
    const linhas = [
      { campo: 'Modelo de interesse', ok: pr.modelo, de: p.total },
      { campo: 'Unidade', ok: pr.unidade, de: p.total },
      { campo: 'Motivo da perda', ok: pr.motivo_perda, de: p.perdidos },
    ];
    renderTabela(document.getElementById('t-qualidade'), linhas, [
      { titulo: 'Campo', valor: l => l.campo },
      { titulo: 'Preenchido', valor: l => `${fmt.int(l.ok)} / ${fmt.int(l.de)}` },
      {
        titulo: 'Cobertura', valor: l => {
          const v = l.de ? 100 * l.ok / l.de : 0;
          const t = v >= 80 ? 'ativo' : 'pausado';
          return `<span class="pilula ${t}">${fmt.pct(v)}</span>`;
        },
      },
    ]);
  }

  /* ====================== ABA MIDIA ====================== */
  function pintarMidia(m, rot) {
    const box = document.getElementById('midia-conteudo');
    const alerta = document.getElementById('alerta-midia');

    if (!m) {
      alerta.innerHTML = `<div class="aviso alerta"><span class="aviso-icone">⏳</span><div>
        <b>Dados de mídia ainda não conectados para esta área.</b>
        ${conta?.erro ? conta.erro : ''}
        Assim que o <code>META_TOKEN</code> for cadastrado nos Secrets do repositório, a coleta automática
        preenche esta aba (conta <code>${cfg.contaId}</code>) duas vezes por dia.
      </div></div>`;
      box.innerHTML = '';
      return;
    }

    alerta.innerHTML = metaParcial
      ? `<div class="aviso alerta"><span class="aviso-icone">⏳</span><div>
          <b>Consulta manual de ${meta.atualizado_em.split(' ')[0]}, só o período de 30 dias.</b>
          ${m.resultados_parciais ? 'Duas campanhas não devolveram o resultado por API nesta leitura, então o custo por resultado da conta inteira aparece como “—” em vez de um número errado. ' : ''}
          A atualização automática entra assim que o <code>META_TOKEN</code> for cadastrado.
        </div></div>`
      : '';

    box.innerHTML = `
      <div class="kpis" id="kpis-midia"></div>
      <div class="grade">
        <div class="card meio">
          <h3>Investimento por dia</h3>
          <p class="dica">Valor gasto na conta ${cfg.contaId}, <span class="js-periodo">${rot}</span>.</p>
          <div class="tela"><canvas id="g-gasto-dia"></canvas></div>
        </div>
        <div class="card meio">
          <h3>${rot_m.plural} por dia</h3>
          <p class="dica">${rot_m.nota[0].toUpperCase() + rot_m.nota.slice(1)}, <span class="js-periodo">${rot}</span>.</p>
          <div class="tela"><canvas id="g-result-dia"></canvas></div>
        </div>
        <div class="card">
          <h3>Campanhas</h3>
          <p class="dica">${m.detalheAproximado
            ? 'O Meta só entrega o detalhe por campanha em janelas fixas — a tabela abaixo é a dos últimos 30 dias, não do intervalo escolhido.'
            : `Ordenado por investimento. ${rot_m.custoCurto} = ${rot_m.custo.toLowerCase()}.`}</p>
          <div id="t-campanhas"></div>
        </div>
        <div class="card">
          <h3>Anúncios</h3>
          <p class="dica">Os criativos que mais consumiram verba no período.</p>
          <div id="t-anuncios"></div>
        </div>
      </div>`;

    document.getElementById('kpis-midia').innerHTML = [
      kpi({ rotulo: 'Investimento', valor: fmt.moedaCurta(m.gasto), nota: rot }),
      kpi({
        rotulo: rot_m.plural, valor: fmt.int(m.resultados),
        nota: m.resultados_parciais ? 'leitura parcial' : rot_m.nota,
        tom: m.resultados_parciais ? 'ruim' : null,
      }),
      kpi({
        rotulo: rot_m.custo,
        valor: m.resultados_parciais || !m.resultados ? '—' : fmt.moeda(m.cpr),
        nota: m.resultados_parciais ? 'aguardando leitura completa' : 'no Meta',
      }),
      kpi({
        rotulo: m.detalheAproximado ? 'Impressões' : 'Alcance',
        valor: fmt.int(m.detalheAproximado ? m.impressoes : m.alcance),
        nota: m.detalheAproximado
          ? 'alcance não é somável entre dias'
          : fmt.int(m.impressoes) + ' impressões',
      }),
      kpi({ rotulo: 'CTR', valor: fmt.pct(m.ctr), nota: fmt.int(m.cliques) + ' cliques' }),
      kpi({ rotulo: 'CPM', valor: fmt.moeda(m.cpm), nota: 'CPC ' + fmt.moeda(m.cpc) }),
    ].join('');

    const s = recorteMeta(conta.serie, base, d0, d1);
    if (s.length) {
      desenhar('g-gasto-dia', ctx => new Chart(ctx, {
        type: 'bar',
        data: {
          labels: s.map(d => fmt.data(d.data)),
          datasets: [{
            label: 'Investimento', data: s.map(d => d.gasto),
            backgroundColor: cor('series-2'), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 18,
          }],
        },
        options: {
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => fmt.moeda(c.parsed.y) } },
          },
          scales: { x: eixoX(), y: eixoY({ ticks: { callback: v => fmt.moedaCurta(v), padding: 8, maxTicksLimit: 6 } }) },
        },
      }));
      desenhar('g-result-dia', ctx => new Chart(ctx, {
        type: 'line',
        data: {
          labels: s.map(d => fmt.data(d.data)),
          datasets: [{
            label: rot_m.plural, data: s.map(d => d.resultados),
            borderColor: cor('series-3'), backgroundColor: 'transparent',
            // monotone: com numeros baixos a curva suave descia abaixo de zero
            borderWidth: 2, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 5,
            pointHoverBackgroundColor: cor('series-3'),
            pointHoverBorderColor: cor('surface-1'), pointHoverBorderWidth: 2,
          }],
        },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false } },
          scales: { x: eixoX(), y: eixoY({ ticks: { precision: 0, padding: 8, maxTicksLimit: 6 } }) },
        },
      }));
    } else {
      ['g-gasto-dia', 'g-result-dia'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.parentElement.innerHTML = vazio('A série diária vem junto com a coleta automática.');
      });
    }

    renderTabela(document.getElementById('t-campanhas'), m.campanhas, [
      { titulo: 'Campanha', valor: l => l.nome },
      { titulo: 'Investido', valor: l => fmt.moeda(l.gasto) },
      { titulo: 'Impressões', valor: l => fmt.int(l.impressoes) },
      { titulo: 'Cliques', valor: l => fmt.int(l.cliques) },
      { titulo: 'CTR', valor: l => fmt.pct(l.ctr) },
      { titulo: 'CPM', valor: l => fmt.moeda(l.cpm) },
      { titulo: rot_m.curto, valor: l => l.resultado_confirmado === false ? '—' : fmt.int(l.resultados) },
      { titulo: rot_m.custoCurto, valor: l => l.resultado_confirmado === false || !l.resultados ? '—' : fmt.moeda(l.cpr) },
    ]);

    montarPrevia();
    const arte = id => conta?.criativos?.[id] || {};
    renderTabela(document.getElementById('t-anuncios'), m.anuncios, [
      {
        titulo: 'Criativo', valor: l => arte(l.id).thumb
          ? `<div class="criativo">
               <span class="criativo-mini" data-previa="${arte(l.id).previa || arte(l.id).thumb}" tabindex="0" role="button" aria-label="Ver prévia de ${l.nome}">
                 <img class="miniatura" src="${arte(l.id).thumb}" alt="" loading="lazy">
                 <span class="criativo-olho" aria-hidden="true">&#128065;</span>
               </span>
               <span>${l.nome}</span>
             </div>`
          : l.nome,
      },
      { titulo: 'Investido', valor: l => fmt.moeda(l.gasto) },
      { titulo: 'Impressões', valor: l => fmt.int(l.impressoes) },
      { titulo: 'CTR', valor: l => fmt.pct(l.ctr) },
      { titulo: rot_m.curto, valor: l => l.resultado_confirmado === false ? '—' : fmt.int(l.resultados) },
      { titulo: rot_m.custoCurto, valor: l => l.resultado_confirmado === false || !l.resultados ? '—' : fmt.moeda(l.cpr) },
    ]);
  }

  iniciarAbas(() => document.dispatchEvent(new CustomEvent('redesenhar')));
  iniciarPeriodo((novo, faixa) => { periodo = novo; custom = faixa; pintar(); }, {
    min: base,
    max: isoLocal(new Date()),
    padraoDe: isoDoDia(intervalo('30d', base, null)[0], base),
  });
  document.addEventListener('redesenhar', () => {
    // Chart.js precisa remedir quando o painel sai de hidden
    setTimeout(() => graficos.forEach(g => g.resize()), 20);
  });
  // trocar de tema muda as cores lidas do CSS, entao repinta tudo
  document.addEventListener('tema-mudou', () => setTimeout(pintar, 40));

  pintar();
}
