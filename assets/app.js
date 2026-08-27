/* SafeWatch dashboard logic: renders data/papers.json,
   draws the topic pie, and wires up filters. */
(() => {
  "use strict";

  const FALLBACK_COLORS = [
    "#38bdf8", "#ff5d8f", "#a78bfa", "#34d399", "#ff9f43", "#60a5fa",
  ];
  const state = {
    data: null,
    day: null,
    cat: null,
    query: "",
  };

  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#paperList");
  const emptyEl = $("#emptyState");

  /* ---------- helpers ---------- */
  const catColor = (cat) =>
    (state.data?.topic_colors || {})[cat] ||
    FALLBACK_COLORS[
      (state.data?.categories || []).indexOf(cat) % FALLBACK_COLORS.length
    ] || "#38bdf8";

  const fmtDate = (iso) => {
    if (!iso) return "";
    return iso.slice(0, 10);
  };

  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };

  function currentDayBucket() {
    const days = state.data.days;
    return (
      days.find((d) => d.batch_date === state.day) ||
      days[0] || { papers: [] }
    );
  }

  /* ---------- stats & header ---------- */
  function renderStats() {
    const d = state.data;
    $("#stat-total").textContent = d.total_papers ?? 0;
    $("#stat-today").textContent = d.total_today ?? 0;
    $("#stat-updated").textContent = (d.last_updated || "").replace("T", " ");
    const repos = new Set(
      d.days.flatMap((day) => day.papers.filter((p) => p.repo).map((p) => p.repo))
    );
    $("#stat-repos").textContent = repos.size;
  }

  function renderDayOptions() {
    const sel = $("#daySelect");
    sel.innerHTML = "";
    state.data.days.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.batch_date;
      opt.textContent = `${fmtDate(d.batch_date)} · ${d.papers.length} papers`;
      sel.appendChild(opt);
      if (i === 0) sel.value = d.batch_date;
    });
    sel.onchange = () => {
      state.day = sel.value;
      renderPapers();
    };
  }

  /* ---------- category chips ---------- */
  function renderChips() {
    const wrap = $("#categoryChips");
    wrap.innerHTML = "";

    const mk = (label, color, val, count) => {
      const b = document.createElement("button");
      b.className = "chip" + (state.cat === val ? " active" : "");
      b.style.setProperty("--cc", color);
      b.textContent = count != null ? `${label} (${count})` : label;
      b.onclick = () => {
        state.cat = state.cat === val ? null : val;
        syncPieSelection();
        renderChips();
        renderPapers();
      };
      wrap.appendChild(b);
    };

    const counts = state.data.category_counts || {};
    mk("All", "#38bdf8", null);
    for (const c of state.data.categories) mk(c, catColor(c), c, counts[c]);
  }

  /* ---------- legend beside the pie ---------- */
  function renderLegend() {
    const ul = $("#legendList");
    ul.innerHTML = "";
    const counts = state.data.category_counts || {};
    for (const c of state.data.categories) {
      const li = document.createElement("li");
      li.className =
        "legend-item" + (state.cat === c ? " active" : "");
      li.style.setProperty("--lc", catColor(c));
      li.innerHTML = `
        <span class="legend-dot"></span>
        <span class="legend-name">${esc(c)}</span>
        <span class="legend-num">${counts[c] ?? 0} · ${esc(
          String(state.data.proportions?.[c] ?? 0)
        )}%</span>`;
      li.onclick = () => {
        state.cat = state.cat === c ? null : c;
        syncPieSelection();
        renderChips();
        renderPapers();
      };
      ul.appendChild(li);
    }
  }

  /* ---------- pie chart ---------- */
  let chart = null;

  function initChart() {
    const el = $("#pieChart");
    chart = echarts.init(el);

    window.addEventListener("resize", () => chart.resize());

    chart.on("click", (params) => {
      state.cat = state.cat === params.name ? null : params.name;
      syncPieSelection();
      renderChips();
      renderLegend();
      renderPapers();
    });
  }

  function drawPie() {
    const seriesData = state.data.categories.map((c) => ({
      name: c,
      value: state.data.category_counts?.[c] || 0,
      itemStyle: { color: catColor(c) },
    }));

    chart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        formatter: "{b}<br/><b>{c} papers</b> ({d}%)",
        backgroundColor: "rgba(17,21,36,0.92)",
        borderColor: "rgba(255,255,255,0.15)",
        textStyle: { color: "#e8ecf8", fontSize: 12 },
      },
      series: [
        {
          type: "pie",
          radius: ["52%", "76%"],
          center: ["50%", "50%"],
          avoidLabelOverlap: true,
          itemStyle: {
            borderRadius: 7,
            borderColor: cssVar("--bg"),
            borderWidth: 3,
          },
          label: {
            show: true,
            formatter: "{d}%",
            color: cssVar("--text-dim"),
            fontSize: 11,
          },
          labelLine: { lineStyle: { color: "rgba(140,150,180,0.4)" } },
          emphasis: {
            scaleSize: 9,
            itemStyle: { shadowBlur: 22, shadowColor: "rgba(0,0,0,0.35)" },
          },
          animationDuration: 900,
          animationEasing: "cubicOut",
          data: seriesData,
        },
      ],
    });
  }

  function syncPieSelection() {
    if (!chart) return;
    chart.dispatchAction({ type: "downplay" });
    if (state.cat) {
      chart.dispatchAction({ type: "highlight", name: state.cat });
      chart.dispatchAction({
        type: "showTip",
        seriesIndex: 0,
        name: state.cat,
      });
    } else {
      chart.dispatchAction({ type: "hideTip" });
    }
  }

  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    undefined;

  /* ---------- paper cards ---------- */
  function paperMatches(p) {
    if (state.cat && p.category !== state.cat) return false;
    if (state.query) {
      const hay = `${p.title} ${p.authors.join(" ")} ${p.abstract}`.toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  function renderPapers() {
    const bucket = currentDayBucket();
    const papers = bucket.papers.filter(paperMatches);
    listEl.innerHTML = "";
    emptyEl.hidden = papers.length > 0;

    for (const p of papers) {
      const card = document.createElement("article");
      card.className = "paper-card";
      card.style.setProperty("--pc", catColor(p.category));

      const authors = p.authors.slice(0, 6).join(", ") +
        (p.authors.length > 6 ? " et al." : "");

      card.innerHTML = `
        <div class="card-top">
          <h3 class="paper-title">
            <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
          </h3>
          <span class="cat-badge">${esc(shortCat(p.category))}</span>
        </div>
        <p class="paper-authors">${esc(authors)} · ${esc(fmtDate(p.date))}</p>
        <p class="paper-abstract">${esc(p.abstract)}</p>
        <button class="abs-toggle">Show abstract ▾</button>
        <div class="card-links">
          <a class="pill" href="${esc(p.url)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
            arXiv · ${esc(p.id)}
          </a>
          ${p.repo ? `
          <a class="pill repo" href="${esc(p.repo)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.94c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.02 1.75 2.68 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .3.21.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>
            Code repository
          </a>` : ""}
        </div>`;

      const btn = card.querySelector(".abs-toggle");
      const abs = card.querySelector(".paper-abstract");
      btn.onclick = (e) => {
        e.stopPropagation();
        abs.classList.toggle("open");
        btn.textContent = abs.classList.contains("open")
          ? "Hide abstract ▴"
          : "Show abstract ▾";
      };

      listEl.appendChild(card);
    }
  }

  const SHORT_LABELS = {
    "Jailbreaking & Red Teaming": "Jailbreak",
    "Prompt Injection & LLM Attacks": "Injection",
    "Reward Hacking & Deceptive Alignment": "Reward Hack",
    "Agentic AI Safety": "Agent Safety",
    "Safety Training & Alignment": "Alignment",
    "Defenses, Privacy & Robustness": "Defenses",
  };
  const shortCat = (c) => SHORT_LABELS[c] || c;

  /* ---------- theme ---------- */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("sw-theme", theme); } catch {}
    if (chart) drawPie(); // re-pick border/label colors
  }

  /* ---------- boot ---------- */
  async function boot() {
    let stored = null;
    try { stored = localStorage.getItem("sw-theme"); } catch {}
    document.documentElement.dataset.theme = stored || "dark";

    try {
      const res = await fetch("data/papers.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
    } catch (err) {
      console.error("Failed to load data/papers.json:", err);
      listEl.innerHTML =
        '<p class="empty-state">Could not load <code>data/papers.json</code>. ' +
        "Run <code>python scripts/update_data.py</code> to generate it.</p>";
      return;
    }

    state.day = state.data.latest_day;
    $("#searchInput").addEventListener("input", (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderPapers();
    });

    initChart();
    renderStats();
    renderDayOptions();
    renderChips();
    renderLegend();
    drawPie();
    renderPapers();

    // scroll reveals
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => en.isIntersecting && en.target.classList.add("in")),
      { threshold: 0.08 }
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

    // back to top button
    const backTop = $("#backTop");
    window.addEventListener("scroll", () => {
      backTop.classList.toggle("show", window.scrollY > 600);
    });
    backTop.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });

    $("#themeToggle").onclick = () =>
      applyTheme(
        document.documentElement.dataset.theme === "light" ? "dark" : "light"
      );
  }

  boot();
})();
