/* SafeWatch Research Net — interactive force graph over data/graph.json.
   Drag nodes to stretch the net; play the time slider to watch the field
   grow; click papers / concepts / edges for details. Requires window.SW
   (exposed by app.js). */
(() => {
  "use strict";

  let G = null;
  let chart = null;
  let stepIdx = 0;
  let topicFilter = null;
  let papersMode = "all";
  let playTimer = null;
  let booted = false;

  const $ = (sel) => document.querySelector(sel);

  /* ---------- derived structures ---------- */
  let papers = [];          // node objects (type paper)
  let concepts = [];        // node objects (type concept)
  let links = [];
  let conceptPapers = new Map();  // term -> [paper ids]
  let paperNode = new Map();      // pid -> node
  let neighbors = new Map();      // concept -> [{term, w}]
  let paperStep = new Map();      // pid -> step idx

  function index() {
    papers = G.nodes.filter((n) => n.type === "paper");
    concepts = G.nodes.filter((n) => n.type === "concept");
    links = G.links;
    paperNode = new Map(papers.map((n) => [n.id, n]));
    conceptPapers = new Map(
      Object.entries(G.conceptPapers || {}).map(([t, ids]) => [t, ids])
    );
    paperStep = new Map(papers.map((n) => [n.id, n.step]));
    neighbors = new Map();
    for (const l of links) {
      if (l.k !== "cc") continue;
      const a = l.s.startsWith("c:") ? l.s.slice(2) : null;
      const b = l.t.startsWith("c:") ? l.t.slice(2) : null;
      if (a && b) {
        if (!neighbors.has(a)) neighbors.set(a, []);
        if (!neighbors.has(b)) neighbors.set(b, []);
        neighbors.get(a).push({ term: b, w: l.w });
        neighbors.get(b).push({ term: a, w: l.w });
      }
    }
  }

  const cum = (term, idx) => {
    const s = G.conceptSeries[term];
    return s ? s[idx] || 0 : 0;
  };

  const papersWith = (term) => {
    // paper ids currently linked to concept `term` (paper-concept edges)
    const cid = "c:" + term;
    const out = new Set();
    for (const l of links) {
      if (l.k !== "pc") continue;
      if (l.t === cid) out.add(l.s.slice(2));
      if (l.s === cid) out.add(l.t.slice(2));
    }
    return [...out];
  };

  function papersModeOk(n) {
    if (papersMode === "curated") return n.curated;
    if (papersMode === "impact") return n.impact >= 7;
    return true;
  }

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
    const vLinks = links.filter((l) => visible.has(l.s) && visible.has(l.t));
    return { nodes: vNodes, links: vLinks };
  }

  function nodeStyle(n, idx) {
    if (n.type === "paper") {
      return {
        symbolSize: 7 + n.impact * 1.2 + (n.curated ? 2 : 0),
        itemStyle: {
          color: G.topicColors[n.topic] || "#38bdf8",
          opacity: 0.92,
        },
        label: {
          show: n.impact >= 8 || n.curated,
          fontSize: 9,
          color: "#8b93a7",
          formatter: () => n.label.slice(0, 34),
        },
      };
    }
    const c = cum(n.label, idx);
    return {
      symbolSize: 8 + Math.sqrt(c) * 2.2,
      itemStyle: {
        color: n.domColor,
        opacity: 0.85,
        borderColor: "rgba(0,0,0,0.35)",
        borderWidth: 1,
      },
      label: { show: true, fontSize: 10, color: "#9aa3bd", formatter: () => n.label },
    };
  }

  const LINK_STYLE = {
    pp: { color: "rgba(148,163,184,0.22)", width: 0.6, curveness: 0.05 },
    pc: { color: "rgba(148,163,184,0.13)", width: 0.5, curveness: 0.03 },
    cc: { color: "rgba(167,139,250,0.30)", width: 1.2, curveness: 0.06 },
  };

  function render() {
    if (!G || !chart) return;
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
            const d = p.data;
            return d.type === "paper"
              ? `${d.label}<br/><b>${d.topic}</b> · impact ${d.impact}${d.upvotes ? " · ♥" + d.upvotes : ""}`
              : `<b>${d.label}</b><br/>${d.df} papers · mostly ${d.domTopic}`;
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
              repulsion: 130,
              gravity: 0.06,
              edgeLength: [28, 80],
              friction: 0.2,
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
    $("#netCount").textContent = `${nodes.filter((n) => n.type === "paper").length} papers · ${nodes.filter((n) => n.type === "concept").length} concepts · ${ls.length} links`;
  }

  /* ---------- concept / edge panels ---------- */
  let panelChart = null;

  function panelSparkline(container, series, labels, colorA, colorB) {
    container.innerHTML = '<div class="net-spark"></div>';
    const el = container.querySelector(".net-spark");
    el.style.width = "100%";
    el.style.height = "170px";
    const c = echarts.init(el);
    c.setOption({
      backgroundColor: "transparent",
      grid: { left: 34, right: 10, top: 24, bottom: 22 },
      tooltip: { trigger: "axis" },
      legend: {
        top: 0, textStyle: { color: "#8b93a7", fontSize: 10 },
        itemWidth: 10,
      },
      xAxis: {
        type: "category",
        data: labels.map((s) => s.slice(5)),
        axisLabel: { color: "#8b93a7", fontSize: 9 },
      },
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#8b93a7", fontSize: 9 } },
      series: [
        { name: colorA.name, type: "line", smooth: true, data: colorA.data, itemStyle: { color: colorA.color }, lineStyle: { color: colorA.color, width: 2 } },
        ...(colorB ? [{
          name: colorB.name, type: "line", smooth: true, data: colorB.data,
          itemStyle: { color: colorB.color },
          lineStyle: { color: colorB.color, width: 2, type: "dashed" },
        }] : []),
      ],
    });
    panelChart = c;
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

  function paperRow(pid) {
    const n = paperNode.get("p:" + pid);
    if (!n) return "";
    return `<li><a data-net-open="${n.id}" href="${n.id ? "javascript:void(0)" : "#"}">${esc(n.label)}</a>
      <span class="d-rel-meta">${esc(shortTopic(n.topic))} · imp ${n.impact}</span></li>`;
  }

  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };
  const TOPIC_SHORT = {
    "Jailbreaking & Red Teaming": "Jailbreak",
    "Prompt Injection & LLM Attacks": "Injection",
    "Reward Hacking & Deceptive Alignment": "Reward Hack",
    "Agentic AI Safety": "Agent Safety",
    "Safety Training & Alignment": "Alignment",
    "Defenses, Privacy & Robustness": "Defenses",
  };
  const shortTopic = (t) => TOPIC_SHORT[t] || t;

  function openConceptPanel(term) {
    const labels = G.steps;
    const series = G.conceptSeries[term] || [];
    const papersList = (G.conceptPapers[term] || []).map(paperRow).join("");
    const nb = (neighbors.get(term) || [])
      .slice()
      .sort((a, b) => b.w - a.w)
      .slice(0, 10);
    openNetPanel(`
      <div class="d-top">
        <span class="cat-badge" style="--pc:#a78bfa">Concept</span>
        <span class="d-date">${cum(term, stepIdx)} papers · first ${labels.find(
          (_, i) => series[i] > 0
        ) || "?"}</span>
      </div>
      <h2 class="d-title">${esc(term)}</h2>
      <p class="panel-sub">Cumulative papers per harvest batch — click a paper to open its detail drawer.</p>
      <div id="netSparkHost"></div>
      <h4 class="d-h">Strongest papers</h4>
      <ul class="d-related">${papersList || "<li>—</li>"}</ul>
      <h4 class="d-h">Co-evolving concepts</h4>
      <div class="mini-tags">${nb
        .map((n) => `<button class="mini-tag" data-net-concept="${esc(n.term)}">${esc(n.term)}</button>`)
        .join("") || "—"}</div>
    `);
    panelSparkline(
      $("#netSparkHost"),
      series, labels,
      { name: term, data: series, color: "#a78bfa" }, null
    );
    wirePanel();
  }

  function openEdgePanel(a, b, w) {
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
        const nx = paperNode.get("p:" + x), ny = paperNode.get("p:" + y);
        return (ny?.impact || 0) - (nx?.impact || 0);
      })
      .slice(0, 8)
      .map(paperRow)
      .join("");

    openNetPanel(`
      <div class="d-top">
        <span class="cat-badge" style="--pc:#38bdf8">Question evolution</span>
        <span class="d-date">${both.length} shared papers</span>
      </div>
      <h2 class="d-title">${esc(a)} <span style="color:#8b93a7">↔</span> ${esc(b)}</h2>
      <p class="panel-sub">How often these two concerns co-occur in one paper, over time — the edge is a research question whose shape is changing. Dashed line: the weaker side alone, for contrast.</p>
      <div id="netSparkHost"></div>
      <h4 class="d-h">Representative papers</h4>
      <ul class="d-related">${rep || "<li>—</li>"}</ul>
    `);
    panelSparkline(
      $("#netSparkHost"), pairCum, labels,
      { name: `${a} ↔ ${b}`, data: pairCum, color: "#38bdf8" },
      { name: a, data: sa, color: "#a78bfa" }
    );
    wirePanel();
  }

  function wirePanel() {
    $("#netPanelBody").querySelectorAll("[data-net-open]").forEach((a) => {
      a.onclick = () => {
        const id = a.dataset.netOpen.replace(/^p:/, "");
        window.SW.openDrawer(id);
      };
    });
    $("#netPanelBody").querySelectorAll("[data-net-concept]").forEach((b) => {
      b.onclick = () => openConceptPanel(b.dataset.netConcept);
    });
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
      btn.textContent = "▶";
      return;
    }
    btn.textContent = "⏸";
    setStep(0);
    playTimer = setInterval(() => {
      if (stepIdx >= G.steps.length - 1) {
        togglePlay();
        return;
      }
      setStep(stepIdx + 1);
    }, 1100);
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

    chart = echarts.init($("#netChart"));
    window.addEventListener("resize", () => chart.resize());

    chart.on("click", (params) => {
      const d = params.data || {};
      if (params.dataType === "node" && d._raw) {
        if (d._raw.type === "paper") window.SW.openDrawer(d._raw.id.slice(2));
        else openConceptPanel(d._raw.label);
        return;
      }
      if (params.dataType === "edge") {
        const a = d.source || "", b = d.target || "";
        if (a.startsWith("c:") && b.startsWith("c:")) {
          openEdgePanel(a.slice(2), b.slice(2), d.value);
        } else if (a.startsWith("p:")) {
          window.SW.openDrawer(a.slice(2));
        } else if (b.startsWith("p:")) {
          window.SW.openDrawer(b.slice(2));
        }
      }
    });

    const slider = $("#netSlider");
    slider.max = String(G.steps.length - 1);
    slider.value = String(G.steps.length - 1);
    stepIdx = G.steps.length - 1;
    slider.addEventListener("input", () => setStep(parseInt(slider.value, 10)));
    $("#netPlay").onclick = togglePlay;
    $("#netMode").addEventListener("change", (e) => {
      papersMode = e.target.value;
      render();
    });
    $("#netPanelClose").onclick = closeNetPanel;
    renderTopicChips();
    render();
  }

  function onShow() { if (chart) setTimeout(() => chart.resize(), 60); }

  window.addEventListener("sw:view", (e) => {
    if (e.detail === "net") {
      boot().then(onShow);
    } else {
      closeNetPanel();
    }
  });
})();
