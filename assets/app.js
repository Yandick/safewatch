/* SafeWatch dashboard logic.
   Views: #home (cockpit KPIs / charts / daily picks) and
   #library?<params> (full corpus, shareable URL state, paginated). */
(() => {
  "use strict";

  const FALLBACK_COLORS = ["#38bdf8", "#ff5d8f", "#a78bfa", "#34d399", "#ff9f43", "#60a5fa"];
  const PAGE_SIZE = 20;
  const HOME_MAX_PICKS = 12;

  const state = {
    data: null,
    cat: null,
    query: "",
    sort: "newest",
    page: 1,
    view: "home",
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------- helpers ---------- */
  const catColor = (cat) =>
    (state.data?.topic_colors || {})[cat] ||
    FALLBACK_COLORS[(state.data?.categories || []).indexOf(cat) % FALLBACK_COLORS.length] ||
    "#38bdf8";

  const fmtDate = (iso) => (iso ? iso.slice(0, 10) : "");

  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };

  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;

  const SHORT_LABELS = {
    "Jailbreaking & Red Teaming": "Jailbreak",
    "Prompt Injection & LLM Attacks": "Injection",
    "Reward Hacking & Deceptive Alignment": "Reward Hack",
    "Agentic AI Safety": "Agent Safety",
    "Safety Training & Alignment": "Alignment",
    "Defenses, Privacy & Robustness": "Defenses",
  };
  const shortCat = (c) => SHORT_LABELS[c] || c;

  /* Complete corpus = union of both tiers, de-duplicated by id.
     Picks override archive copies (they carry richer fields). */
  function corpus() {
    const byId = new Map();
    for (const day of state.data.days) {
      for (const p of day.collected || []) if (!byId.has(p.id)) byId.set(p.id, p);
      for (const p of day.papers || []) byId.set(p.id, p);
    }
    for (const p of byId.values()) p.curated = false;
    for (const day of state.data.days) {
      for (const p of day.papers || []) byId.get(p.id).curated = true;
    }
    return [...byId.values()];
  }

  /* ---------- shareable library URL state ---------- */
  function libParamsFromURL() {
    const qs = new URLSearchParams((location.hash.split("?")[1] || ""));
    const sort = ["newest", "upvotes", "score"].includes(qs.get("sort"))
      ? qs.get("sort")
      : "newest";
    const cat = qs.get("cat");
    return {
      q: qs.get("q") || "",
      cat: cat && state.data.categories.includes(cat) ? cat : null,
      sort,
      page: Math.max(1, parseInt(qs.get("page"), 10) || 1),
    };
  }

  function syncLibFromURL() {
    const p = libParamsFromURL();
    state.query = p.q;
    state.cat = p.cat;
    state.sort = p.sort;
    state.page = p.page;
  }

  function writeLibHash(push) {
    const params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.cat) params.set("cat", state.cat);
    if (state.sort !== "newest") params.set("sort", state.sort);
    if (state.page > 1) params.set("page", String(state.page));
    const qs = params.toString();
    const target = "#library" + (qs ? "?" + qs : "");
    if (push && target !== location.hash) history.pushState(null, "", target);
    else history.replaceState(null, "", target);
  }

  function syncControls() {
    $("#searchInput").value = state.query;
    $("#libSort").value = state.sort;
    renderChips();
  }

  /* ---------- routing ---------- */
  function setView(view) {
    state.view = view;
    $("#view-home").hidden = view !== "home";
    $("#view-library").hidden = view !== "library";
    $$("[data-route]").forEach((a) =>
      a.classList.toggle("nav-active", a.getAttribute("href") === `#${view}`)
    );
  }

  function route() {
    const hash = location.hash || "#home";
    if (hash.startsWith("#library")) {
      syncLibFromURL();
      setView("library");
      syncControls();
      renderLibrary();
      window.scrollTo({ top: 0 });
    } else {
      setView("home");
      if (hash.startsWith("#topics")) {
        setTimeout(() => $("#view-home").scrollIntoView({ behavior: "smooth" }), 60);
      }
    }
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
      $("#picksList").innerHTML =
        '<p class="empty-state">Could not load <code>data/papers.json</code>. ' +
        "Run <code>python scripts/update_data.py</code> to generate it.</p>";
      $("#libCount").textContent = "–";
      return;
    }

    initChart();
    initTrendChart();
    renderStats();
    renderChips();
    renderLegend();
    drawPie();
    drawTrend();
    renderHomePicks();

    // library filters <-> URL
    let debounceT;
    $("#searchInput").addEventListener("input", (e) => {
      clearTimeout(debounceT);
      debounceT = setTimeout(() => {
        state.query = e.target.value.trim().toLowerCase();
        state.page = 1;
        writeLibHash(true);
        renderChips();
        renderLibrary();
      }, 250);
    });
    $("#searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(debounceT);
        state.query = e.target.value.trim().toLowerCase();
        state.page = 1;
        writeLibHash(true);
        renderLibrary();
      }
    });
    $("#libSort").addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.page = 1;
      writeLibHash(true);
      renderLibrary();
    });

    window.addEventListener("hashchange", route);
    route(); // may land directly on #library?q=...

    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => en.isIntersecting && en.target.classList.add("in")),
      { threshold: 0.08 }
    );
    $$(".reveal").forEach((el) => io.observe(el));

    const backTop = $("#backTop");
    window.addEventListener("scroll", () =>
      backTop.classList.toggle("show", window.scrollY > 600)
    );
    backTop.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });

    $("#themeToggle").onclick = () =>
      applyTheme(
        document.documentElement.dataset.theme === "light" ? "dark" : "light"
      );
  }

  /* ---------- stats ---------- */
  function renderStats() {
    const d = state.data;
    $("#stat-total").textContent = d.total_papers ?? 0;
    $("#stat-today").textContent = d.total_today ?? 0;
    $("#stat-repos").textContent = new Set(
      d.days.flatMap((day) =>
        [...(day.papers || []), ...(day.collected || [])]
          .filter((p) => p.repo)
          .map((p) => p.repo)
      )
    ).size;
    const ts = (d.last_updated || "");
    // "2026-08-27T13:15:35+00:00" -> "08-27 13:15 UTC" (year lives in tooltip)
    $("#stat-updated").textContent = ts.length >= 16
      ? `${ts.slice(5, 10)} ${ts.slice(11, 16)} UTC`
      : ts;
    $("#stat-updated").title = ts.replace("T", " ");

    const badge = $("#curatedBadge");
    if (badge && d.curated_by && d.curated_by !== "rule-based") {
      badge.textContent = `✨ AI-curated · ${d.curated_by}`;
      badge.hidden = false;
    }
  }

  /* ---------- category chips ---------- */
  function renderChips() {
    const wrap = $("#categoryChips");
    if (!wrap) return;
    wrap.innerHTML = "";
    const counts = state.data.category_counts || {};

    const mk = (label, color, val, count) => {
      const b = document.createElement("button");
      b.className = "chip" + (state.cat === val ? " active" : "");
      b.style.setProperty("--cc", color);
      b.textContent = count != null ? `${label} (${count})` : label;
      b.onclick = () => {
        state.cat = state.cat === val ? null : val;
        state.page = 1;
        writeLibHash(true);
        renderChips();
        renderLibrary();
      };
      wrap.appendChild(b);
    };

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
      li.style.setProperty("--lc", catColor(c));
      li.innerHTML = `
        <span class="legend-dot"></span>
        <span class="legend-name">${esc(c)}</span>
        <span class="legend-num">${counts[c] ?? 0} · ${esc(String(state.data.proportions?.[c] ?? 0))}%</span>`;
      li.onclick = () => openCategoryInLibrary(c);
      ul.appendChild(li);
    }
  }

  function openCategoryInLibrary(c) {
    state.cat = c;
    state.page = 1;
    setView("library");
    writeLibHash(true);
    syncControls();
    renderLibrary();
    window.scrollTo({ top: 0 });
  }

  /* ---------- pie chart ---------- */
  let chart = null;

  function initChart() {
    chart = echarts.init($("#pieChart"));
    window.addEventListener("resize", () => chart.resize());
    chart.on("click", (params) => openCategoryInLibrary(params.name));
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
          radius: ["50%", "74%"],
          center: ["50%", "52%"],
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
            scaleSize: 8,
            itemStyle: { shadowBlur: 22, shadowColor: "rgba(0,0,0,0.35)" },
          },
          animationDuration: 900,
          animationEasing: "cubicOut",
          data: seriesData,
        },
      ],
    });
    $(".pie-holder")?.classList.add("is-ready");
  }

  /* ---------- collection trend chart ---------- */
  let trendChart = null;

  function initTrendChart() {
    trendChart = echarts.init($("#trendChart"));
    window.addEventListener("resize", () => trendChart.resize());
  }

  function drawTrend() {
    const days = [...state.data.days].sort((a, b) =>
      a.batch_date < b.batch_date ? -1 : 1
    );
    const dates = days.map((d) => fmtDate(d.batch_date).slice(5));
    const series = state.data.categories.map((c) => ({
      name: c,
      type: "bar",
      stack: "papers",
      barMaxWidth: 34,
      itemStyle: { color: catColor(c) },
      emphasis: { focus: "series" },
      data: days.map(
        (d) =>
          (d.collected && d.collected.length ? d.collected : d.papers || []).filter(
            (p) => p.category === c
          ).length
      ),
    }));

    const hasBoth = days.some(
      (d) => d.collected && d.papers && d.collected.length !== d.papers.length
    );
    if (hasBoth) {
      series.push({
        name: "★ Curated picks",
        type: "line",
        smooth: true,
        symbolSize: 6,
        lineStyle: { width: 2.5, color: "#fbbf24" },
        itemStyle: { color: "#fbbf24" },
        data: days.map((d) => (d.papers || []).length),
      });
    }

    trendChart.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: "rgba(17,21,36,0.92)",
        borderColor: "rgba(255,255,255,0.15)",
        textStyle: { color: "#e8ecf8", fontSize: 12 },
      },
      legend: {
        top: 0,
        type: "scroll",
        textStyle: { color: cssVar("--text-dim"), fontSize: 11 },
        pageIconColor: cssVar("--accent"),
        pageTextStyle: { color: cssVar("--text-dim") },
      },
      grid: { left: 8, right: 8, top: 44, bottom: 0, containLabel: true },
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: {
          color: cssVar("--text-dim"),
          rotate: dates.length > 6 ? 38 : 0,
          fontSize: 10.5,
        },
        axisLine: { lineStyle: { color: "rgba(140,150,180,0.35)" } },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { color: cssVar("--text-dim"), fontSize: 10.5 },
        splitLine: { lineStyle: { color: "rgba(140,150,180,0.16)" } },
      },
      series,
    });
    document.querySelector(".chart-holder:not(.pie-holder)")?.classList.add("is-ready");
  }

  /* ---------- shared card builders ---------- */
  const ICON_EXT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
  const ICON_GH =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.94c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.02 1.75 2.68 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .3.21.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>';

  function cardHTML(p, opts = {}) {
    const brief = !!opts.brief;
    const authors = p.authors
      ? p.authors.slice(0, 6).join(", ") + (p.authors.length > 6 ? " et al." : "")
      : "";
    const metaParts = [];
    if (!brief && authors) metaParts.push(esc(authors));
    metaParts.push(esc(fmtDate(p.date)));
    return `
      <div class="card-top">
        <h3 class="paper-title">
          <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
        </h3>
        <span class="cat-badge">${esc(shortCat(p.category))}</span>
      </div>
      ${metaParts.length ? `<p class="paper-authors">${metaParts.join(" · ")}${p.curated ? ' <span class="pick-star">★</span>' : ""}</p>` : ""}
      ${p.tldr ? `<p class="paper-tldr"><span class="tldr-tag">AI</span>${esc(p.tldr)}</p>` : ""}
      <div class="card-links">
        <a class="pill" href="${esc(p.url)}" target="_blank" rel="noopener">${ICON_EXT} arXiv · ${esc(p.id)}</a>
        ${p.repo ? `<a class="pill repo" href="${esc(p.repo)}" target="_blank" rel="noopener">${ICON_GH} Code</a>` : ""}
        ${p.upvotes ? `<span class="pill upv" title="Hugging Face community upvotes">♥ ${esc(p.upvotes)}</span>` : ""}
      </div>`;
  }

  function makeCard(p, opts) {
    const card = document.createElement("article");
    card.className = "paper-card" + (opts.brief ? " paper-card--brief" : "");
    card.style.setProperty("--pc", catColor(p.category));
    card.innerHTML = cardHTML(p, opts);
    return card;
  }

  /* ---------- home: latest picks (brief grid) ---------- */
  function renderHomePicks() {
    // Accumulate picks from the newest update batches until the digest is
    // full (or 3 batches scanned) — a thin harvest still fills the grid.
    const picks = [];
    let usedBatches = 0;
    for (const day of state.data.days) {
      if (picks.length >= HOME_MAX_PICKS || usedBatches >= 3) break;
      const dayPicks = (day.papers || [])
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (!dayPicks.length) continue;
      picks.push(...dayPicks);
      usedBatches++;
    }
    picks.length = Math.min(picks.length, HOME_MAX_PICKS);

    const wrap = $("#picksList");
    wrap.innerHTML = "";
    $("#picksEmpty").hidden = picks.length > 0;
    for (const p of picks) wrap.appendChild(makeCard(p, { brief: true }));

    const sub = $("#picksSub");
    const staleH =
      (Date.now() - Date.parse(state.data.last_updated || "")) / 36e5;
    let prefix = "";
    if (sub) {
      if (staleH > 40) {
        prefix = "⚠ Data may be stale (last run " +
          fmtDate(state.data.last_updated) + ") — ";
        sub.classList.add("stale");
      } else {
        sub.classList.remove("stale");
      }
      sub.textContent =
        prefix +
        `Fresh reading from your last ${usedBatches} update batch` +
        (usedBatches === 1 ? "." : "es.");
    }
  }

  /* ---------- library ---------- */
  function libraryMatches(p) {
    if (state.cat && p.category !== state.cat) return false;
    if (state.query) {
      const hay = `${p.title} ${p.authors ? p.authors.join(" ") : ""} ${p.abstract || ""}`.toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  function sortedLib(list) {
    const arr = list.slice();
    if (state.sort === "upvotes") {
      arr.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
    } else if (state.sort === "score") {
      arr.sort(
        (a, b) => (b.ai_imp ?? b.score ?? -1) - (a.ai_imp ?? a.score ?? -1)
      );
    } else {
      arr.sort((a, b) => {
        const d = String(b.date || "").localeCompare(String(a.date || ""));
        return d !== 0 ? d : (b.curated ? 1 : 0) - (a.curated ? 1 : 0);
      });
    }
    return arr;
  }

  function renderPager(totalPages) {
    const pagerEl = $("#pager");
    pagerEl.innerHTML = "";
    if (totalPages <= 1) {
      pagerEl.hidden = true;
      return;
    }
    pagerEl.hidden = false;

    const go = (page) => {
      state.page = page;
      writeLibHash(true);
      renderLibrary();
      $("#libList").scrollIntoView({ behavior: "smooth" });
    };
    const btn = (label, page, opts = {}) => {
      const b = document.createElement("button");
      b.className = "pager-btn" + (opts.active ? " active" : "") + (opts.gap ? " gap" : "");
      b.type = "button";
      b.innerHTML = opts.gap ? "…" : label;
      if (opts.disabled) b.disabled = true;
      else if (!opts.gap) b.onclick = () => go(page);
      pagerEl.appendChild(b);
    };

    btn("‹ Prev", state.page - 1, { disabled: state.page <= 1 });
    const pages = [];
    for (
      let i = Math.max(1, state.page - 2);
      i <= Math.min(totalPages, state.page + 2);
      i++
    )
      pages.push(i);
    if (pages[0] > 1) pages.unshift(1);
    if (pages[pages.length - 1] < totalPages) pages.push(totalPages);
    let prev = 0;
    for (const i of pages) {
      if (prev && i - prev > 1) btn("", i, { gap: true });
      btn(String(i), i, { active: i === state.page });
      prev = i;
    }
    btn("Next ›", state.page + 1, { disabled: state.page >= totalPages });
  }

  function renderLibrary() {
    if (!state.data) return;
    let items = corpus().filter(libraryMatches);
    items = sortedLib(items);

    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * PAGE_SIZE;
    const slice = items.slice(start, start + PAGE_SIZE);

    $("#libCount").textContent = `${items.length}`;
    $("#libEmpty").hidden = slice.length > 0;

    const list = $("#libList");
    list.innerHTML = "";
    for (const p of slice) list.appendChild(makeCard(p, { brief: false }));
    renderPager(totalPages);
  }

  /* ---------- theme ---------- */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("sw-theme", theme); } catch {}
    if (chart) drawPie();
    if (trendChart) drawTrend();
  }

  boot();
})();
