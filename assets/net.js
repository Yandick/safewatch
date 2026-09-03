/* SafeWatch Research Net — two lenses on the same graph:
   1) Timeline (default, trend-first): papers by harvest date × topic lane,
      with concept-burst pins (CiteSpace/Litmaps-inspired).
   2) Graph (exploration): force graph, drag to rearrange, concept/edge panels.
   Requires window.SW (exposed by app.js). */
(() => {
  "use strict";

  let G = null;
  let chart = null;        // active echarts instance (graph or timeline)
  let activeView = "timeline";
  let stepIdx = 0;
  let topicFilter = null;
  let papersMode = "curated";
  let showPPEdges = false;
  let playTimer = null;
  let booted = false;

  const $ = (sel) => document.querySelector(sel);

  /* ---------- index the graph ---------- */
  let papers = [];
  let concepts = [];
  let links = [];
  let conceptPapers = new Map();
  let neighbors = new Map();
  let paperStep = new Map();
  let byId = new Map();

  function index() {
    papers = G.nodes.filter((n) => n.type === "paper");
    concepts = G.nodes.filter((n) => n.type === "concept");
    links = G.links;
    byId = new Map(G.nodes.map((n) => [n.id, n]));
    paperStep = new Map(papers.map((n) => [n.id, n.step]));
    conceptPapers = new Map(Object.entries(G.conceptPapers || {}));
    neighbors = new Map();
    for (const l of links) {
      if (l.k !== "cc") continue;
      const a = l.s.startsWith("c:") ? l.s.slice(2) : null;
      const b = l.t.startsWith("c:") ? l.t.slice(2) : null;
      if (a && b) {
        for (const [x, y] of [[a, b], [b, a]]) {
          if (!neighbors.has(x)) neighbors.set(x, []);
          neighbors.get(x).push({ term: y, w: l.w });
        }
      }
    }
  }

  const cum = (term, idx) => {
    const s = G.conceptSeries[term];
    return s ? s[idx] || 0 : 0;
  };

  const papersWith = (term) => {
    const cid = "c:" + term;
    const out = new Set();
    for (const l of links) {
      if (l.k !== "pc") continue;
      if (l.t === cid) out.add(l.s.slice(2));
      if (l.s === cid) out.add(l.t.slice(2));
    }
    return [...out];
  };

  /* ---------- burst detection (client-side, CiteSpace-style) ---------- */
  function detectBursts(minJump = 2, topN = 14) {
    const bursts = [];
    for (const [term, s] of Object.entries(G.conceptSeries)) {
      for (let i = 1; i < s.length; i++) {
        const jump = s[i] - s[i - 1];
        if (jump >= minJump) {
          bursts.push({ term, step: i, jump, cum: s[i] });
        }
      }
    }
    // strongest jump per term, keep latest steps meaningful
    const best = new Map();
    for (const b of bursts) {
      if (!best.has(b.term) || b.jump > best.get(b.term).jump) best.set(b.term, b);
    }
    return [...best.values()]
      .sort((a, b) => b.jump - a.jump)
      .slice(0, topN);
  }

  const SHORT = {
    "Jailbreaking & Red Teaming": "Jailbreak",
    "Prompt Injection & LLM Attacks": "Injection",
    "Reward Hacking & Deceptive Alignment": "Reward Hack",
    "Agentic AI Safety": "Agent Safety",
    "Safety Training & Alignment": "Alignment",
    "Defenses, Privacy & Robustness": "Defenses",
  };
  const shortTopic = (t) => SHORT[t] || t;

  /* ================= TIMELINE (trend lens) ================= */
  function renderTimeline() {
    const el = $("#timelineChart");
    el.hidden = false;
    $("#netChart").hidden = true;
    $("#graphControls").hidden = true;

    const series = [];
    const topics = Object.keys(G.topicColors);

    for (const t of topics) {
      const data = papers
        .filter((n) => n.topic === t &&
          (!topicFilter || n.topic === topicFilter) &&
          papersModeOk(n))
        .map((n) => ({
          value: [n.step, n.impact],
          id: n.id,
          name: n.label,
          upvotes: n.upvotes,
          curated: n.curated,
        }));
      series.push({
        name: shortTopic(t),
        type: "scatter",
        data,
        symbolSize: (val) => 7 + (val[1] || 1) * 1.9 + 2,
        itemStyle: { color: G.topicColors[t], opacity: 0.85 },
        emphasis: {
          focus: "self",
          label: {
            show: true,
            formatter: (p) => p.data.name.slice(0, 40),
            fontSize: 11,
            color: "#e8ecf8",
            position: "top",
          },
        },
      });
    }

    // burst pins
    const bursts = detectBursts();
    const pinData = [];
    for (const b of bursts) {
      const term = b.term;
      const node = byId.get("c:" + term);
      const lane = topics.indexOf(node ? node.domTopic : topics[0]);
      if (lane < 0) continue;
      pinData.push({
        value: [b.step, lane],
        name: term,
        jump: b.jump,
        symbolRotate: 180,
      });
    }
    series.push({
      name: "🔺 bursting concepts",
      type: "scatter",
      data: pinData,
      symbol: "pin",
      symbolSize: (val, p) => 26 + Math.min(p.data.jump * 3, 22),
      itemStyle: { color: "#fbbf24", opacity: 0.95 },
      label: {
        show: true,
        position: "top",
        distance: 2,
        formatter: (p) => p.data.name,
        fontSize: 12,
        fontWeight: 700,
        color: "#fbbf24",
        textBorderColor: "rgba(0,0,0,0.6)",
        textBorderWidth: 2,
      },
      z: 10,
    });

    chart.setOption(
      {
        backgroundColor: "transparent",
        grid: { left: 90, right: 30, top: 40, bottom: 42 },
        tooltip: {
          formatter: (p) => {
            if (p.seriesName.startsWith("🔺")) {
              return `<b>${p.data.name}</b><br/>+${p.data.jump} new papers at ${G.steps[p.data.value[0]]}<br/>click to search`;
            }
            return `${p.data.name}<br/><b>${p.seriesName}</b> · impact ${p.data.value[1]}${p.data.upvotes ? " · ♥" + p.data.upvotes : ""}<br/>harvested ${G.steps[p.data.value[0]]}<br/>click for details`;
          },
          backgroundColor: "rgba(17,21,36,0.94)",
          borderColor: "rgba(255,255,255,0.15)",
          textStyle: { color: "#e8ecf8", fontSize: 12 },
        },
        legend: {
          top: 0,
          type: "scroll",
          textStyle: { color: "#9aa3bd", fontSize: 11 },
          inactiveColor: "#3a4258",
        },
        xAxis: {
          type: "category",
          data: G.steps.map((s) => s.slice(5)),
          name: "harvest →",
          nameLocation: "middle",
          nameGap: 26,
          nameTextStyle: { color: "#8b93a7" },
          axisLabel: { color: "#9aa3bd", fontSize: 11 },
          axisLine: { lineStyle: { color: "rgba(140,150,180,0.35)" } },
        },
        yAxis: {
          type: "value",
          min: -0.5,
          max: topics.length - 0.5,
          interval: 1,
          axisLabel: {
            formatter: (v) => (topics[v] ? shortTopic(topics[v]) : ""),
            color: "#c7cfe2",
            fontSize: 12,
            fontWeight: 600,
          },
          splitLine: { show: false },
        },
        series,
      },
      { notMerge: true }
    );

    chart.off("click");
    chart.on("click", (params) => {
      if (params.seriesName.startsWith("🔺")) {
        window.SW.goSearch(params.data.name);
        return;
      }
      if (params.data.id) window.SW.openDrawer(params.data.id.replace(/^p:/, ""));
    });
  }

  function papersModeOk(n) {
    if (papersMode === "curated") return n.curated;
    if (papersMode === "impact") return n.impact >= 7;
    return true;
  }

  /* ================= GRAPH (exploration lens) ================= */
  function datasetFor(idx) {
    const vNodes = [];
    const visible = new Set();
    for (const n of papers) {
      const ok =
        n.step <= idx && papersModeOk(n) &&
        (!topicFilter || n.topic === topicFilter);
      if (ok) { vNodes.push(n); visible.add(n.id); }
    }
    for (const n of concepts) {
      if (cum(n.label, idx) > 0) { vNodes.push(n); visible.add(n.id); }
    }
    const vLinks = links.filter((l) => {
      if (l.k === "pp" && !showPPEdges) return false;
      return visible.has(l.s) && visible.has(l.t);
    });
    return { nodes: vNodes, links: vLinks };
  }

  function nodeStyle(n, idx) {
    if (n.type === "paper") {
      return {
        symbol: "circle",
        symbolSize: 9 + n.impact * 1.4 + (n.curated ? 2 : 0),
        itemStyle: { color: G.topicColors[n.topic] || "#38bdf8", opacity: 0.92 },
        label: { show: false },
      };
    }
    const c = cum(n.label, idx);
    return {
      symbol: "diamond",
      symbolSize: 10 + Math.sqrt(c) * 2.6,
      itemStyle: {
        color: n.domColor,
        opacity: 0.9,
        borderColor: "rgba(0,0,0,0.4)",
        borderWidth: 1,
      },
      label: {
        show: true,
        position: "top",
        distance: 4,
        fontSize: 13,
        fontWeight: 600,
        color: "#d7dcee",
        formatter: () => n.label,
      },
    };
  }

  const LINK_STYLE = {
    pp: { color: "rgba(148,163,184,0.22)", width: 0.6, curveness: 0.05 },
    pc: { color: "rgba(148,163,184,0.13)", width: 0.5, curveness: 0.03 },
    cc: { color: "rgba(167,139,250,0.35)", width: 1.4, curveness: 0.06 },
  };

  function renderGraph() {
    const el = $("#netChart");
    el.hidden = false;
    $("#timelineChart").hidden = true;
    $("#graphControls").hidden = false;

    const { nodes, links: ls } = datasetFor(stepIdx);
    chart.setOption(
      {
        backgroundColor: "transparent",
        tooltip: {
          formatter: (p) => {
            if (p.dataType === "edge") {
              const a = p.data.source.split(":").pop();
              const b = p.data.target.split(":").pop();
              return `${a} ↔ ${b}<br/>weight ${p.data.w}`;
            }
            const d = p.data._raw || {};
            return d.type === "paper"
              ? `${d.label}<br/><b>${d.topic}</b> · impact ${d.impact}${d.upvotes ? " · ♥" + d.upvotes : ""}`
              : `<b>${d.label}</b><br/>mentioned by ${d.df} papers · mostly ${d.domTopic}`;
          },
          backgroundColor: "rgba(17,21,36,0.94)",
          borderColor: "rgba(255,255,255,0.15)",
          textStyle: { color: "#e8ecf8", fontSize: 12 },
        },
        series: [
          {
            type: "graph",
            layout: "force",
            roam: true,
            draggable: true,
            data: nodes.map((n) => ({
              id: n.id,
              name: n.label,
              ...nodeStyle(n, stepIdx),
              _raw: n,
            })),
            links: ls.map((l) => ({
              source: l.s,
              target: l.t,
              value: l.w,
              lineStyle: LINK_STYLE[l.k] || LINK_STYLE.pp,
            })),
            force: {
              repulsion: 260,
              gravity: 0.05,
              edgeLength: [46, 115],
              friction: 0.18,
              layoutAnimation: true,
            },
            emphasis: { focus: "adjacency", label: { show: true } },
            labelLayout: { hideOverlap: true },
            zlevel: 2,
          },
        ],
      },
      { notMerge: true }
    );
    $("#netStepLabel").textContent = G.steps[stepIdx];
    $("#netCount").textContent = `${nodes.filter((n) => n.type === "paper").length} papers · ${nodes.filter((n) => n.type === "concept").length} concepts`;
  }

  /* ---------- concept / edge panels ---------- */
  let panelChart = null;

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

  function paperRow(pid) {
    const n = byId.get("p:" + pid);
    if (!n) return "";
    return `<li><a data-net-open="${n.id}" href="javascript:void(0)">${esc(n.label)}</a>
      <span class="d-rel-meta">${esc(shortTopic(n.topic))} · imp ${n.impact}</span></li>`;
  }

  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };

  function spark(host, labels, primary, secondary) {
    host.innerHTML = '<div class="net-spark"></div>';
    const el = host.querySelector(".net-spark");
    el.style.width = "100%";
    el.style.height = "180px";
    const c = echarts.init(el);
    c.setOption({
      backgroundColor: "transparent",
      grid: { left: 34, right: 10, top: 26, bottom: 22 },
      tooltip: { trigger: "axis" },
      legend: {
        top: 0, textStyle: { color: "#8b93a7", fontSize: 10 }, itemWidth: 10,
      },
      xAxis: {
        type: "category",
        data: labels.map((s) => s.slice(5)),
        axisLabel: { color: "#8b93a7", fontSize: 10 },
      },
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#8b93a7", fontSize: 10 } },
      series: [
        {
          name: primary.name, type: "line", smooth: true, data: primary.data,
          itemStyle: { color: primary.color },
          lineStyle: { color: primary.color, width: 2.4 },
        },
        ...(secondary ? [{
          name: secondary.name, type: "line", smooth: true, data: secondary.data,
          itemStyle: { color: secondary.color },
          lineStyle: { color: secondary.color, width: 2, type: "dashed" },
        }] : []),
      ],
    });
    panelChart = c;
  }

  function wirePanel() {
    $("#netPanelBody").querySelectorAll("[data-net-open]").forEach((a) => {
      a.onclick = () => window.SW.openDrawer(a.dataset.netOpen.replace(/^p:/, ""));
    });
    $("#netPanelBody").querySelectorAll("[data-net-concept]").forEach((b) => {
      b.onclick = () => openConceptPanel(b.dataset.netConcept);
    });
  }

  function openConceptPanel(term) {
    const labels = G.steps;
    const series = G.conceptSeries[term] || [];
    const papersList = (G.conceptPapers[term] || []).map(paperRow).join("");
    const nb = (neighbors.get(term) || [])
      .slice().sort((a, b) => b.w - a.w).slice(0, 10);
    openNetPanel(`
      <div class="d-top">
        <span class="cat-badge" style="--pc:#a78bfa">Concept</span>
        <span class="d-date">${cum(term, stepIdx)} papers total</span>
      </div>
      <h2 class="d-title">${esc(term)}</h2>
      <p class="panel-sub">Cumulative papers per harvest batch. Click a paper for its drawer; click a co-evolving concept to hop.</p>
      <div id="netSparkHost"></div>
      <h4 class="d-h">Strongest papers</h4>
      <ul class="d-related">${papersList || "<li>—</li>"}</ul>
      <h4 class="d-h">Co-evolving concepts</h4>
      <div class="mini-tags">${nb
        .map((n) => `<button class="mini-tag" data-net-concept="${esc(n.term)}">${esc(n.term)}</button>`)
        .join("") || "—"}</div>
    `);
    spark($("#netSparkHost"), labels,
      { name: term, data: series, color: "#a78bfa" }, null);
    wirePanel();
  }

  function openEdgePanel(a, b) {
    const labels = G.steps;
    const sa = G.conceptSeries[a] || [];
    const sb = G.conceptSeries[b] || [];
    const setA = new Set(papersWith(a));
    const both = papersWith(b).filter((pid) => setA.has(pid));
    const perStep = new Array(labels.length).fill(0);
    for (const pid of both) perStep[paperStep.get(pid) ?? 0] += 1;
    let c = 0;
    const pairCum = perStep.map((v) => (c += v));
    const rep = both
      .sort((x, y) => {
        const nx = byId.get("p:" + x), ny = byId.get("p:" + y);
        return (ny?.impact || 0) - (nx?.impact || 0);
      })
      .slice(0, 8).map(paperRow).join("");

    openNetPanel(`
      <div class="d-top">
        <span class="cat-badge" style="--pc:#38bdf8">Question evolution</span>
        <span class="d-date">${both.length} shared papers</span>
      </div>
      <h2 class="d-title">${esc(a)} <span style="color:#8b93a7">↔</span> ${esc(b)}</h2>
      <p class="panel-sub">Co-occurrence per harvest batch: this edge is a research question whose shape changes over time. Dashed = the weaker side alone.</p>
      <div id="netSparkHost"></div>
      <h4 class="d-h">Representative papers</h4>
      <ul class="d-related">${rep || "<li>—</li>"}</ul>
    `);
    spark($("#netSparkHost"), labels,
      { name: `${a} ↔ ${b}`, data: pairCum, color: "#38bdf8" },
      { name: a, data: sa, color: "#a78bfa" });
    wirePanel();
  }

  /* ---------- controls ---------- */
  function renderTopicChips() {
    const wrap = $("#netTopics");
    wrap.innerHTML = "";
    const mk = (label, val, color) => {
      const b = document.createElement("button");
      b.className = "chip" + (topicFilter === val ? " active" : "");
      b.style.setProperty("--cc", color);
      b.textContent = label;
      b.onclick = () => {
        topicFilter = topicFilter === val ? null : val;
        renderTopicChips();
        render();
      };
      wrap.appendChild(b);
    };
    mk("All topics", null, "#38bdf8");
    for (const [t, c] of Object.entries(G.topicColors)) mk(shortTopic(t), t, c);
  }

  function setStep(idx) {
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

  function setNetView(v) {
    activeView = v === "graph" ? "graph" : "timeline";
    $$("#netViewSeg .seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.netview === activeView)
    );
    $("#netViewSub").textContent =
      activeView === "timeline"
        ? "Papers placed by harvest date (x) and topic (lane). Bubble size = AI impact. 🔺 pins are bursting concepts — this is where the field accelerates."
        : "Exploration lens: drag to rearrange, hover to see neighborhoods, click violet edges for a question's evolution. For trends, stay on Timeline.";
    render();
  }

  function render() {
    if (!G || !chart) return;
    if (activeView === "timeline") renderTimeline();
    else renderGraph();
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

    chart = echarts.init($("#timelineChart"));
    chart.on("legendscroll", () => {});
    window.addEventListener("resize", () => {
      chart.resize();
      if (panelChart) panelChart.resize();
    });

    chart.getZr().dom.addEventListener("dblclick", () => {});

    const slider = $("#netSlider");
    slider.max = String(G.steps.length - 1);
    slider.value = String(G.steps.length - 1);
    stepIdx = G.steps.length - 1;
    slider.addEventListener("input", () => setStep(parseInt(slider.value, 10)));
    $("#netPlay").onclick = togglePlay;
    $("#netMode").value = papersMode;
    $("#netMode").addEventListener("change", (e) => {
      papersMode = e.target.value;
      render();
    });
    $("#netPP").addEventListener("change", (e) => {
      showPPEdges = e.target.checked;
      render();
    });
    $("#netPanelClose").onclick = closeNetPanel;
    $$("#netViewSeg .seg-btn").forEach((b) => {
      b.onclick = () => setNetView(b.dataset.netview);
    });
    renderTopicChips();
    render();
  }

  function onShow() {
    if (chart) setTimeout(() => { chart.resize(); render(); }, 60);
  }

  window.addEventListener("sw:view", (e) => {
    if (e.detail === "net") boot().then(onShow);
    else closeNetPanel();
  });
})();
