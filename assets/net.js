/* SafeWatch Research Forest — lineage trees of safety-research concepts,
   growing bottom-up as harvests accumulate (roots = established questions,
   shoots = new directions). Deterministic: built by scripts/graph.py.
   Click a node for its concept panel; replay growth with ▶ / slider.
   Requires window.SW (exposed by app.js). */
(() => {
  "use strict";

  let G = null;
  let chart = null;
  let stepIdx = 0;
  let playTimer = null;
  let booted = false;
  let panelChart = null;

  const $ = (sel) => document.querySelector(sel);

  /* ---------- data ---------- */
  let conceptSeries = new Map();
  let conceptPapers = new Map();
  let childrenMap = new Map();   // concept -> child concepts
  let parentMap = new Map();     // concept -> parent concept

  function index() {
    conceptSeries = new Map(Object.entries(G.conceptSeries || {}));
    conceptPapers = new Map(Object.entries(G.conceptPapers || {}));
    childrenMap = new Map();
    parentMap = new Map();
    const walk = (node) => {
      childrenMap.set(node.name, (node.children || []).map((c) => c.name));
      for (const c of node.children || []) {
        parentMap.set(c.name, node.name);
        walk(c);
      }
    };
    for (const t of G.forest || []) walk(t);
  }

  const cum = (term, idx) => {
    const s = conceptSeries.get(term);
    return s ? s[idx] || 0 : 0;
  };

  /* ---------- forest render ---------- */
  function pruneForest(node, idx) {
    const kids = (node.children || [])
      .map((c) => pruneForest(c, idx))
      .filter(Boolean);
    if (node.step > idx && kids.length === 0) return null;
    return {
      name: node.name,
      step: node.step,
      df: node.df,
      topic: node.topic,
      children: kids,
    };
  }

  let leafCount = 0;

  function render() {
    if (!G || !chart) return;
    const forest = (G.forest || [])
      .map((t) => pruneForest(t, stepIdx))
      .filter(Boolean);

    leafCount = 0;
    const count = (n) => { leafCount += 1; (n.children || []).forEach(count); };
    forest.forEach(count);

    chart.setOption(
      {
        backgroundColor: "transparent",
        tooltip: {
          trigger: "item",
          formatter: (p) => {
            const d = p.data;
            return `<b>${d.name}</b><br/>appeared ${G.steps[d.step] || "?"} · mentioned by ${d.df} papers${d.topic ? `<br/>mostly ${d.topic}` : ""}<br/>click for details & papers`;
          },
          backgroundColor: "rgba(17,21,36,0.94)",
          borderColor: "rgba(255,255,255,0.15)",
          textStyle: { color: "#e8ecf8", fontSize: 12 },
        },
        series: [
          {
            type: "tree",
            data: forest,
            orient: "BT", // roots at the bottom, growing upward like a forest
            left: "5%", right: "5%", top: "5%", bottom: "7%",
            roam: true,
            expandAndCollapse: false,
            initialTreeDepth: -1,
            symbol: "circle",
            symbolSize: (val, params) =>
              9 + Math.sqrt(params.data.df || 1) * 2.2,
            itemStyle: {
              color: (params) =>
                (params.data.topic && G.topicColors[params.data.topic]) ||
                "#a78bfa",
              borderColor: "rgba(0,0,0,0.4)",
              borderWidth: 1,
            },
            lineStyle: { color: "rgba(148,163,184,0.45)", width: 1.6 },
            label: {
              position: "top",
              distance: 5,
              fontSize: 12.5,
              fontWeight: 600,
              color: "#d7dcee",
              formatter: (p) => p.data.name,
            },
            leaves: {
              label: { show: true, fontSize: 11.5, color: "#9aa3bd", position: "top" },
            },
            emphasis: { focus: "descendant" },
            animationDuration: 550,
            animationDurationUpdate: 700,
          },
        ],
      },
      { notMerge: true }
    );

    $("#netStepLabel").textContent = G.steps[stepIdx];
    $("#netCount").textContent =
      `${leafCount} concepts · ${forest.length} lineage trees`;
  }

  function setStep(idx) {
    if (!G) return;
    stepIdx = Math.max(0, Math.min(G.steps.length - 1, idx));
    $("#netSlider").value = String(stepIdx);
    render();
  }

  function togglePlay() {
    const btn = $("#netPlay");
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      btn.textContent = "▶ Play growth";
      return;
    }
    btn.textContent = "⏸";
    setStep(0);
    playTimer = setInterval(() => {
      if (stepIdx >= G.steps.length - 1) { togglePlay(); return; }
      setStep(stepIdx + 1);
    }, 1100);
  }

  /* ---------- concept panel ---------- */
  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };

  function openConceptPanel(term) {
    const labels = G.steps;
    const series = conceptSeries.get(term) || [];
    const papersList = (conceptPapers.get(term) || [])
      .map((pid) => {
        const n = paperMeta(pid);
        return n
          ? `<li><a data-net-open="${esc(pid)}" href="javascript:void(0)">${esc(n.label)}</a> <span class="d-rel-meta">${esc(n.topic || "")}</span></li>`
          : "";
      })
      .join("");
    const related = [
      ...(childrenMap.get(term) || []),
      ...(parentMap.has(term) ? [parentMap.get(term)] : []),
    ].filter((t) => t && t !== term);

    openNetPanel(`
      <div class="d-top">
        <span class="cat-badge" style="--pc:#a78bfa">Concept</span>
        <span class="d-date">${cum(term, stepIdx)} papers total</span>
      </div>
      <h2 class="d-title">${esc(term)}</h2>
      <p class="panel-sub">Cumulative papers per harvest batch. Click a paper for its drawer; click a related concept to hop.</p>
      <div id="netSparkHost"></div>
      <h4 class="d-h">Strongest papers</h4>
      <ul class="d-related">${papersList || "<li>—</li>"}</ul>
      <h4 class="d-h">Related concepts</h4>
      <div class="mini-tags">${related
        .map((t) => `<button class="mini-tag" data-net-concept="${esc(t)}">${esc(t)}</button>`)
        .join("") || "—"}</div>
    `);
    spark($("#netSparkHost"), labels,
      { name: term, data: series, color: "#a78bfa" }, null);
    wirePanel();
  }

  let paperMeta = () => null;

  function spark(host, labels, primary) {
    host.innerHTML = '<div class="net-spark"></div>';
    const el = host.querySelector(".net-spark");
    el.style.width = "100%";
    el.style.height = "180px";
    panelChart = echarts.init(el);
    panelChart.setOption({
      backgroundColor: "transparent",
      grid: { left: 34, right: 10, top: 20, bottom: 22 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: labels.map((s) => s.slice(5)),
        axisLabel: { color: "#8b93a7", fontSize: 10 },
      },
      yAxis: {
        type: "value", minInterval: 1,
        axisLabel: { color: "#8b93a7", fontSize: 10 },
      },
      series: [{
        name: primary.name, type: "line", smooth: true, data: primary.data,
        itemStyle: { color: primary.color },
        lineStyle: { color: primary.color, width: 2.4 },
        areaStyle: { color: primary.color, opacity: 0.12 },
      }],
    });
  }

  function wirePanel() {
    $("#netPanelBody").querySelectorAll("[data-net-open]").forEach((a) => {
      a.onclick = () => window.SW.openDrawer(a.dataset.netOpen);
    });
    $("#netPanelBody").querySelectorAll("[data-net-concept]").forEach((b) => {
      b.onclick = () => openConceptPanel(b.dataset.netConcept);
    });
  }

  function openNetPanel(html) {
    $("#netPanelBody").innerHTML = html;
    const p = $("#netPanel");
    p.hidden = false;
    requestAnimationFrame(() => p.classList.add("open"));
  }

  function closeNetPanel() {
    const p = $("#netPanel");
    p.classList.remove("open");
    if (panelChart) { panelChart.dispose(); panelChart = null; }
    setTimeout(() => { p.hidden = true; }, 260);
  }

  /* ---------- boot ---------- */
  async function boot() {
    if (booted) return;
    booted = true;
    const res = await fetch("data/graph.json", { cache: "no-store" });
    if (!res.ok) {
      $("#netCount").textContent = "graph.json unavailable";
      return;
    }
    G = await res.json();
    index();

    // paper titles for panels come from app.js corpus
    const cm = window.SW.corpusMap();
    paperMeta = (pid) => {
      const p = cm.get(pid);
      return p ? { label: p.title, topic: p.category } : null;
    };

    chart = echarts.init($("#forestChart"));
    window.addEventListener("resize", () => {
      chart.resize();
      if (panelChart) panelChart.resize();
    });

    chart.on("click", (params) => {
      if (params.data?.name) openConceptPanel(params.data.name);
    });

    const slider = $("#netSlider");
    slider.max = String(G.steps.length - 1);
    slider.value = String(G.steps.length - 1);
    stepIdx = G.steps.length - 1;
    slider.addEventListener("input", () => setStep(parseInt(slider.value, 10)));
    $("#netPlay").onclick = togglePlay;
    $("#netPanelClose").onclick = closeNetPanel;

    setTimeout(() => { chart.resize(); render(); }, 60);
    render();
  }

  function onShow() {
    boot().then(() => {
      setTimeout(() => { chart.resize(); render(); }, 60);
    });
  }

  window.addEventListener("sw:view", (e) => {
    if (e.detail === "net") onShow();
    else closeNetPanel();
  });
})();
