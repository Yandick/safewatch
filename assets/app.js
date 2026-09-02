/* SafeWatch dashboard logic.
   Views: #home (cockpit / picks) · #library?<params> (corpus, shareable) ·
   #mine (personal workspace). Plus a paper detail drawer, keyboard flow,
   topic momentum, emerging keywords and a weekly digest export. */
(() => {
  "use strict";

  const FALLBACK_COLORS = ["#38bdf8", "#ff5d8f", "#a78bfa", "#34d399", "#ff9f43", "#60a5fa"];
  const PAGE_SIZE = 20;
  const HOME_MAX_PICKS = 12;

  const state = {
    data: null,
    abstracts: {},        // id -> abstract (from data/abstracts.json sidecar)
    cat: null,
    query: "",
    sort: "newest",
    page: 1,
    view: "home",
    personalFilter: null, // null | "starred" | "unread" (library chips)
    hideReadMine: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------- tiny helpers ---------- */
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

  const abstractOf = (p) => p.abstract || state.abstracts[p.id] || "";

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- personal workspace (localStorage) ---------- */
  const P = {
    data: { papers: {} },
    load() {
      try {
        const raw = localStorage.getItem("sw-personal");
        if (raw) this.data = JSON.parse(raw);
      } catch {}
      if (!this.data || typeof this.data !== "object") this.data = {};
      if (!this.data.papers) this.data.papers = {};
    },
    save() {
      try { localStorage.setItem("sw-personal", JSON.stringify(this.data)); }
      catch {}
    },
    rec(id) {
      if (!this.data.papers[id]) this.data.papers[id] = {};
      return this.data.papers[id];
    },
    peek(id) { return this.data.papers[id] || {}; },
    starred(id) { return !!this.peek(id).starred; },
    toggleStar(id) {
      const r = this.rec(id);
      r.starred = !r.starred;
      if (r.starred) r.starredAt = Date.now(); else delete r.starredAt;
      this.save();
    },
    markRead(id, v = true) { this.rec(id).read = v; this.save(); },
    setNote(id, txt) {
      const r = this.rec(id);
      if (txt) r.note = txt; else delete r.note;
      this.save();
    },
    setTags(id, tags) {
      const r = this.rec(id);
      if (tags.length) r.tags = tags; else delete r.tags;
      this.save();
    },
    starredPapers() {
      return Object.keys(this.data.papers)
        .filter((id) => this.data.papers[id].starred)
        .sort((a, b) => (this.data.papers[b].starredAt || 0) - (this.data.papers[a].starredAt || 0));
    },
  };

  /* ---------- corpus ---------- */
  let CORPUS_MAP = null;

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

  function corpusMap() {
    if (!CORPUS_MAP) CORPUS_MAP = new Map(corpus().map((p) => [p.id, p]));
    return CORPUS_MAP;
  }

  /* ---------- shareable library URL state ---------- */
  function libParamsFromURL() {
    const qs = new URLSearchParams((location.hash.split("?")[1] || ""));
    const sort = ["newest", "upvotes", "score"].includes(qs.get("sort"))
      ? qs.get("sort")
      : "newest";
    const cat = qs.get("cat");
    const pf = qs.get("personal");
    return {
      q: qs.get("q") || "",
      cat: cat && state.data.categories.includes(cat) ? cat : null,
      sort,
      page: Math.max(1, parseInt(qs.get("page"), 10) || 1),
      personal: ["starred", "unread"].includes(pf) ? pf : null,
    };
  }

  function syncLibFromURL() {
    const p = libParamsFromURL();
    state.query = p.q;
    state.cat = p.cat;
    state.sort = p.sort;
    state.page = p.page;
    state.personalFilter = p.personal;
  }

  function writeLibHash(push) {
    const params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.cat) params.set("cat", state.cat);
    if (state.sort !== "newest") params.set("sort", state.sort);
    if (state.page > 1) params.set("page", String(state.page));
    if (state.personalFilter) params.set("personal", state.personalFilter);
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
    $("#view-mine").hidden = view !== "mine";
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
    } else if (hash.startsWith("#mine")) {
      setView("mine");
      renderMine();
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
    P.load();
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

    // abstracts sidecar (optional, written by scripts/enrich.py)
    fetch("data/abstracts.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => { state.abstracts = j || {}; })
      .catch(() => {});

    initChart();
    initTrendChart();
    renderStats();
    renderChips();
    renderLegend();
    drawPie();
    drawTrend();
    renderEmerging();
    renderHomePicks();

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
    route();

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

    // digest export
    $("#digestBtn").onclick = exportWeeklyDigest;

    // my library controls
    $("#mineHideRead").onclick = (e) => {
      state.hideReadMine = !state.hideReadMine;
      e.target.classList.toggle("active", state.hideReadMine);
      renderMine();
    };
    $("#exportMd").onclick = exportMarkdown;
    $("#exportBib").onclick = exportBibtex;
    $("#exportJson").onclick = () =>
      download(
        "safewatch-personal-" + new Date().toISOString().slice(0, 10) + ".json",
        JSON.stringify(P.data, null, 2),
        "application/json"
      );
    $("#importJsonBtn").onclick = () => $("#importJson").click();
    $("#importJson").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const parsed = JSON.parse(rd.result);
          if (!parsed || typeof parsed !== "object" || !parsed.papers)
            throw new Error("bad format");
          P.data = parsed;
          P.save();
          renderMine();
          alert("Personal library imported ✓");
        } catch (err) {
          alert("Import failed: " + err.message);
        }
      };
      rd.readAsText(f);
      e.target.value = "";
    });

    // drawer controls
    $("#drawerClose").onclick = closeDrawer;
    $("#drawerOverlay").onclick = closeDrawer;
    $("#drawerBody").addEventListener("click", (e) => {
      const open = e.target.closest("[data-open]");
      if (open) { openDrawer(open.dataset.open); return; }
      const untag = e.target.closest("[data-untag]");
      if (untag && drawerPaperId) {
        const tags = (P.peek(drawerPaperId).tags || []).filter(
          (t) => t !== untag.dataset.untag
        );
        P.setTags(drawerPaperId, tags);
        renderDrawer(corpusMap().get(drawerPaperId));
      }
    });
    $("#drawerBody").addEventListener("input", (e) => {
      if (e.target.id === "drawerNote" && drawerPaperId) {
        clearTimeout(drawerBody._noteT);
        drawerBody._noteT = setTimeout(
          () => P.setNote(drawerPaperId, e.target.value), 400
        );
      }
    });
    $("#drawerBody").addEventListener("keydown", (e) => {
      if (e.target.id === "drawerTags" && e.key === "Enter") {
        e.preventDefault();
        const tags = e.target.value
          .split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
        if (drawerPaperId && tags.length) {
          const merged = [...new Set([...(P.peek(drawerPaperId).tags || []), ...tags])];
          P.setTags(drawerPaperId, merged);
          renderDrawer(corpusMap().get(drawerPaperId));
        }
      }
    });

    // card-level delegation (drawer open + star)
    for (const sel of ["#picksList", "#libList", "#mineList"]) {
      $(sel).addEventListener("click", onCardClick);
    }

    initKeyboard();
  }

  function onCardClick(e) {
    const star = e.target.closest("[data-star]");
    if (star) {
      toggleStarById(star.dataset.star);
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      e.preventDefault();
      openDrawer(open.dataset.open);
    }
  }

  function toggleStarById(id) {
    P.toggleStar(id);
    const on = P.starred(id);
    $$(`[data-star="${CSS.escape(id)}"]`).forEach((b) => {
      b.classList.toggle("on", on);
    });
    $$(`[data-card="${CSS.escape(id)}"]`).forEach((c) =>
      c.classList.toggle("starred", on)
    );
    if (drawerPaperId === id) syncDrawerPersonal();
    if (state.view === "mine") renderMine();
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
    const ts = d.last_updated || "";
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

  /* ---------- category chips (+ personal filters) ---------- */
  function renderChips() {
    const wrap = $("#categoryChips");
    if (!wrap) return;
    wrap.innerHTML = "";
    const counts = state.data.category_counts || {};

    const mk = (label, color, val, count, active) => {
      const b = document.createElement("button");
      b.className = "chip" + (active ? " active" : "");
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

    mk("All", "#38bdf8", null, null, state.cat === null && !state.personalFilter);
    for (const c of state.data.categories) mk(c, catColor(c), c, counts[c], state.cat === c);

    // personal-scope filters
    for (const [key, label] of [["starred", "★ starred"], ["unread", "unread"]]) {
      const b = document.createElement("button");
      b.className = "chip" + (state.personalFilter === key ? " active" : "");
      b.style.setProperty("--cc", "#fbbf24");
      b.textContent = label;
      b.onclick = () => {
        state.personalFilter = state.personalFilter === key ? null : key;
        state.page = 1;
        writeLibHash(true);
        renderChips();
        renderLibrary();
      };
      wrap.appendChild(b);
    }
  }

  /* ---------- legend + momentum ---------- */
  function renderLegend() {
    const ul = $("#legendList");
    ul.innerHTML = "";
    const counts = state.data.category_counts || {};
    const mom = state.data.momentum || {};
    for (const c of state.data.categories) {
      const li = document.createElement("li");
      li.style.setProperty("--lc", catColor(c));
      const m = mom[c];
      const arrow =
        m == null ? "" :
        m >= 10 ? ' <span class="mom mom-up">↑</span>' :
        m <= -10 ? ' <span class="mom mom-down">↓</span>' : "";
      li.innerHTML = `
        <span class="legend-dot"></span>
        <span class="legend-name">${esc(c)}</span>
        <span class="legend-num">${counts[c] ?? 0} · ${esc(String(state.data.proportions?.[c] ?? 0))}%${arrow}</span>`;
      li.onclick = () => openCategoryInLibrary(c);
      ul.appendChild(li);
    }
  }

  /* ---------- emerging keywords ---------- */
  function renderEmerging() {
    const row = $("#emergingRow");
    if (!row) return;
    const items = state.data.emerging || [];
    if (!items.length) { row.hidden = true; return; }
    row.hidden = false;
    row.innerHTML =
      '<span class="emerging-label">🔺 Emerging this week:</span>' +
      items
        .map(
          (it) =>
            `<button class="chip term" type="button" data-term="${esc(it.term)}">${esc(it.term)} <span class="term-n">${it.count}</span></button>`
        )
        .join("");
    row.querySelectorAll("[data-term]").forEach((b) => {
      b.onclick = () => {
        state.query = b.dataset.term.toLowerCase();
        state.cat = null;
        state.page = 1;
        setView("library");
        writeLibHash(true);
        syncControls();
        renderLibrary();
        window.scrollTo({ top: 0 });
      };
    });
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

  /* ---------- card builders ---------- */
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
    const rec = P.peek(p.id);
    return `
      <div class="card-top">
        <h3 class="paper-title">
          <a href="${esc(p.url)}" data-open="${esc(p.id)}">${esc(p.title)}</a>
        </h3>
        <span class="cat-badge">${esc(shortCat(p.category))}</span>
        <button class="star-btn${rec.starred ? " on" : ""}" data-star="${esc(p.id)}" title="Star (s)" type="button">★</button>
      </div>
      ${metaParts.length ? `<p class="paper-authors">${metaParts.join(" · ")}${p.curated ? ' <span class="pick-star">★</span>' : ""}${rec.read ? ' <span class="read-mark">read</span>' : ""}</p>` : ""}
      ${p.tldr ? `<p class="paper-tldr"><span class="tldr-tag">AI</span>${esc(p.tldr)}</p>` : ""}
      <div class="card-links">
        <a class="pill" href="${esc(p.url)}" target="_blank" rel="noopener">${ICON_EXT} arXiv · ${esc(p.id)}</a>
        ${p.repo ? `<a class="pill repo" href="${esc(p.repo)}" target="_blank" rel="noopener">${ICON_GH} Code</a>` : ""}
        ${p.upvotes ? `<span class="pill upv" title="Hugging Face community upvotes">♥ ${esc(p.upvotes)}</span>` : ""}
      </div>`;
  }

  function makeCard(p, opts) {
    const card = document.createElement("article");
    card.className =
      "paper-card" +
      (opts.brief ? " paper-card--brief" : "") +
      (P.peek(p.id).read ? " is-read" : "") +
      (P.peek(p.id).starred ? " starred" : "");
    card.dataset.card = p.id;
    card.style.setProperty("--pc", catColor(p.category));
    card.innerHTML = cardHTML(p, opts);
    return card;
  }

  /* ---------- home: latest picks (brief grid) ---------- */
  function renderHomePicks() {
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
    if (state.personalFilter === "starred" && !P.starred(p.id)) return false;
    if (state.personalFilter === "unread" && P.peek(p.id).read) return false;
    if (state.cat && p.category !== state.cat) return false;
    if (state.query) {
      const hay = `${p.title} ${p.authors ? p.authors.join(" ") : ""} ${abstractOf(p)}`.toLowerCase();
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

  /* ---------- my library ---------- */
  function renderMine() {
    if (!state.data) return;
    const ids = P.starredPapers();
    let items = ids.map((id) => corpusMap().get(id)).filter(Boolean);
    if (state.hideReadMine) items = items.filter((p) => !P.peek(p.id).read);
    items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

    $("#mineCount").textContent = `${P.starredPapers().length} starred`;
    const list = $("#mineList");
    list.innerHTML = "";
    const visible = items.filter(
      (p) => !state.hideReadMine || !P.peek(p.id).read
    );
    $("#mineEmpty").hidden = visible.length > 0;
    for (const p of visible) {
      const card = makeCard(p, { brief: false });
      const rec = P.peek(p.id);
      if (rec.tags?.length || rec.note) {
        const extra = document.createElement("div");
        extra.className = "personal-extra";
        extra.innerHTML =
          (rec.tags?.length
            ? `<div class="mini-tags">${rec.tags
                .map((t) => `<span class="mini-tag">${esc(t)}</span>`)
                .join("")}</div>`
            : "") +
          (rec.note ? `<p class="mini-note">📝 ${esc(rec.note)}</p>` : "");
        card.appendChild(extra);
      }
      list.appendChild(card);
    }
    if (state.hideReadMine) {
      // count reflects visible semantics
      $("#mineCount").textContent = `${items.length} starred`;
    }
  }

  /* ---------- BibTeX ---------- */
  function buildBibtex(p) {
    const year = p.date ? p.date.slice(0, 4) : "";
    const firstAuthor = (p.authors && p.authors[0] ? p.authors[0] : "unknown")
      .split(" ").pop().toLowerCase().replace(/[^a-z]/g, "");
    const firstWord = (p.title.split(/\s+/)[0].replace(/\W/g, "") || "paper").toLowerCase();
    const key = `${firstAuthor}${year}${firstWord}`;
    const authors = (p.authors || ["Unknown"]).map((a) => {
      const parts = a.trim().split(/\s+/);
      const last = parts.pop();
      return `${last}, ${parts.join(" ")}`;
    }).join(" and ");
    return [
      `@misc{${key},`,
      `  title         = {${p.title}},`,
      `  author        = {${authors}},`,
      `  year          = {${year}},`,
      `  eprint        = {${p.id}},`,
      `  archivePrefix = {arXiv},`,
      `  url           = {${p.url}}`,
      `}`,
    ].join("\n");
  }

  /* ---------- exports ---------- */
  function exportMarkdown() {
    const ids = P.starredPapers();
    const byTopic = {};
    for (const id of ids) {
      const p = corpusMap().get(id);
      if (!p) continue;
      (byTopic[p.category] ||= []).push(p);
    }
    const L = [
      `# SafeWatch — My Reading List`,
      ``,
      `_Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · ${ids.length} starred papers_`,
      ``,
    ];
    for (const topic of Object.keys(byTopic)) {
      L.push(`## ${topic}`, ``);
      for (const p of byTopic[topic]) {
        const rec = P.peek(p.id);
        L.push(`- **[${p.title}](${p.url})** — ${fmtDate(p.date)} · arXiv:${p.id}`);
        if (p.tldr) L.push(`  - TL;DR: ${p.tldr}`);
        if (p.repo) L.push(`  - Code: ${p.repo}`);
        if (rec.tags?.length) L.push(`  - Tags: ${rec.tags.join(", ")}`);
        if (rec.note) L.push(`  - Note: ${rec.note}`);
      }
      L.push(``);
    }
    download(
      "safewatch-reading-list-" + new Date().toISOString().slice(0, 10) + ".md",
      L.join("\n"),
      "text/markdown;charset=utf-8"
    );
  }

  function exportBibtex() {
    const entries = P.starredPapers()
      .map((id) => corpusMap().get(id))
      .filter(Boolean)
      .map(buildBibtex);
    download(
      "safewatch-reading-list.bib",
      entries.join("\n\n"),
      "text/plain;charset=utf-8"
    );
  }

  function exportWeeklyDigest() {
    const d = state.data;
    const today = new Date();
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const recentDays = d.days.filter((x) => x.batch_date >= cutoff);
    const picks = recentDays
      .flatMap((x) => x.papers || [])
      .slice()
      .sort((a, b) => (b.ai_imp ?? b.score ?? 0) - (a.ai_imp ?? a.score ?? 0))
      .slice(0, 10);
    const L = [
      `# SafeWatch Weekly Digest`,
      ``,
      `_Harvest window: ${cutoff} → ${today.toISOString().slice(0, 10)} · generated ${today.toISOString().slice(0, 16).replace("T", " ")} UTC_`,
      ``,
      `## Top picks by AI impact`,
      ``,
    ];
    for (const p of picks) {
      L.push(`- **[${p.title}](${p.url})** — ${shortCat(p.category)} · impact ${p.ai_imp ?? "?"}/10 · arXiv:${p.id}`);
      if (p.tldr) L.push(`  - ${p.tldr}`);
    }
    const mom = d.momentum || {};
    const mrows = Object.entries(mom);
    if (mrows.length) {
      L.push(``, `## Topic momentum (this week vs last)`, ``);
      for (const [topic, delta] of mrows.sort((a, b) => b[1] - a[1])) {
        L.push(`- ${delta >= 0 ? "↑" : "↓"} **${topic}**: ${delta >= 0 ? "+" : ""}${delta}%`);
      }
    }
    if ((d.emerging || []).length) {
      L.push(``, `## Emerging keywords`, ``);
      L.push(d.emerging.map((it) => `\`${it.term}\` (${it.count})`).join(" · "));
    }
    const starred = P.starredPapers().map((id) => corpusMap().get(id)).filter(Boolean);
    if (starred.length) {
      L.push(``, `## My starred (${starred.length})`, ``);
      for (const p of starred) L.push(`- [${p.title}](${p.url})`);
    }
    L.push(``, `---`, `_Auto-generated by SafeWatch — https://yandick.github.io/safewatch/_`);
    download(
      "safewatch-digest-" + today.toISOString().slice(0, 10) + ".md",
      L.join("\n"),
      "text/markdown;charset=utf-8"
    );
  }

  /* ---------- paper drawer ---------- */
  let drawerPaperId = null;
  let readTimer = null;

  function openDrawer(id) {
    const p = corpusMap().get(id);
    if (!p) return;
    drawerPaperId = id;
    $("#drawerOverlay").hidden = false;
    const dr = $("#drawer");
    dr.hidden = false;
    requestAnimationFrame(() => {
      $("#drawerOverlay").classList.add("open");
      dr.classList.add("open");
    });
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      if (drawerPaperId === id && !P.peek(id).read) {
        P.markRead(id);
        refreshPersonalBits(id);
      }
    }, 2000);
    renderDrawer(p);
    document.body.style.overflow = "hidden";
  }

  function closeDrawer() {
    clearTimeout(readTimer);
    $("#drawerOverlay").classList.remove("open");
    $("#drawer").classList.remove("open");
    setTimeout(() => {
      $("#drawerOverlay").hidden = true;
      $("#drawer").hidden = true;
    }, 260);
    drawerPaperId = null;
    document.body.style.overflow = "";
  }

  function refreshPersonalBits(id) {
    const rec = P.peek(id);
    $$(`[data-star="${CSS.escape(id)}"]`).forEach((b) =>
      b.classList.toggle("on", !!rec.starred)
    );
    $$(`[data-card="${CSS.escape(id)}"]`).forEach((c) => {
      c.classList.toggle("is-read", !!rec.read);
      const mark = c.querySelector(".read-mark");
      if (rec.read && !mark) {
        const au = c.querySelector(".paper-authors");
        if (au) au.insertAdjacentHTML("beforeend", ' <span class="read-mark">read</span>');
      }
    });
    if (state.view === "mine") renderMine();
  }

  function syncDrawerPersonal() {
    const p = corpusMap().get(drawerPaperId);
    if (p) renderDrawer(p);
  }

  function renderDrawer(p) {
    const rec = P.peek(p.id);
    const abs = abstractOf(p);
    const id = p.id;
    const related = (p.related || [])
      .map((rid) => corpusMap().get(rid))
      .filter(Boolean)
      .slice(0, 5);

    $("#drawerBody").innerHTML = `
      <div class="d-top">
        <span class="cat-badge" style="--pc:${catColor(p.category)}">${esc(shortCat(p.category))}</span>
        <span class="d-date">${esc(fmtDate(p.date))}</span>
        ${p.curated ? '<span class="pick-star">★ curated</span>' : ""}
        ${p.upvotes ? `<span class="pill upv">♥ ${esc(p.upvotes)}</span>` : ""}
        ${p.ai_rel != null ? `<span class="d-score mono">AI ${p.ai_rel}/10 · impact ${p.ai_imp ?? "?"}/10</span>` : ""}
      </div>
      <h2 class="d-title">${esc(p.title)}</h2>
      ${p.tldr ? `<p class="paper-tldr"><span class="tldr-tag">AI</span>${esc(p.tldr)}</p>` : ""}
      <div class="d-links">
        <a class="pill" href="${esc(p.url)}" target="_blank" rel="noopener">${ICON_EXT} abs</a>
        <a class="pill" href="https://arxiv.org/pdf/${esc(id)}" target="_blank" rel="noopener">PDF</a>
        <a class="pill" href="https://ar5iv.labs.arxiv.org/html/${esc(id)}" target="_blank" rel="noopener">ar5iv</a>
        <a class="pill" href="https://huggingface.co/papers/${esc(id)}" target="_blank" rel="noopener">HF</a>
        <a class="pill" href="https://www.alphaxiv.org/abs/${esc(id)}" target="_blank" rel="noopener">alphaXiv</a>
        ${p.repo ? `<a class="pill repo" href="${esc(p.repo)}" target="_blank" rel="noopener">${ICON_GH} Code</a>` : ""}
      </div>
      ${abs ? `<h4 class="d-h">Abstract</h4><p class="d-abstract">${esc(abs)}</p>` : ""}
      <h4 class="d-h">My research notes</h4>
      <textarea id="drawerNote" class="d-note" rows="4" placeholder="Why does this matter for your research? (autosaved)">${esc(rec.note || "")}</textarea>
      <div class="d-tags-row">
        <input id="drawerTags" class="d-tags-input" placeholder="add tags (space/comma) + Enter" value="" />
        <span class="mini-tags">${(rec.tags || [])
          .map((t) => `<span class="mini-tag">${esc(t)} <button data-untag="${esc(t)}" type="button">×</button></span>`)
          .join("")}</span>
      </div>
      <div class="d-actions">
        <button id="dStar" class="chip${rec.starred ? " active" : ""}" type="button">★ ${rec.starred ? "Starred" : "Star"}</button>
        <button id="dRead" class="chip${rec.read ? " active" : ""}" type="button">${rec.read ? "✓ Read" : "Mark unread"}</button>
        <button id="dBib" class="chip" type="button">Copy BibTeX</button>
      </div>
      ${related.length ? `<h4 class="d-h">Related papers</h4><ul class="d-related">${related
        .map(
          (r) =>
            `<li><a data-open="${esc(r.id)}" href="${esc(r.url)}">${esc(r.title)}</a> <span class="d-rel-meta">${esc(shortCat(r.category))}</span></li>`
        )
        .join("")}</ul>` : ""}`;

    $("#dStar").onclick = () => { toggleStarById(id); };
    $("#dRead").onclick = () => {
      P.markRead(id, !P.peek(id).read);
      refreshPersonalBits(id);
      renderDrawer(corpusMap().get(id));
    };
    $("#dBib").onclick = async () => {
      try { await navigator.clipboard.writeText(buildBibtex(p)); }
      catch { /* noop */ }
      $("#dBib").textContent = "Copied ✓";
      setTimeout(() => { $("#dBib").textContent = "Copy BibTeX"; }, 1500);
    };
  }

  /* ---------- keyboard flow ---------- */
  let cursorIdx = -1;

  function activeListEl() {
    return state.view === "library"
      ? $("#libList")
      : state.view === "mine"
      ? $("#mineList")
      : $("#picksList");
  }

  function cursorCards() {
    return [...activeListEl().querySelectorAll(".paper-card")];
  }

  function moveCursor(delta) {
    const cards = cursorCards();
    if (!cards.length) return;
    cursorIdx = (cursorIdx + delta + cards.length) % cards.length;
    cards.forEach((c, i) => c.classList.toggle("cursor", i === cursorIdx));
    cards[cursorIdx].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function initKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if (e.key === "Escape") { closeDrawer(); return; }
      if (e.key === "/") {
        e.preventDefault();
        if (state.view !== "library") {
          location.hash = "#library";
          setTimeout(() => $("#searchInput").focus(), 150);
        } else {
          $("#searchInput").focus();
        }
        return;
      }
      if (drawerPaperId) return;

      const cards = cursorCards();
      const cur = cards[cursorIdx];
      const curId = cur ? cur.dataset.card : null;

      if (e.key === "j") { e.preventDefault(); moveCursor(1); }
      else if (e.key === "k") { e.preventDefault(); moveCursor(-1); }
      else if (e.key === "Enter" && curId) { openDrawer(curId); }
      else if (e.key === "s" && curId) { toggleStarById(curId); }
      else if (e.key === "m" && curId) {
        P.markRead(curId, !P.peek(curId).read);
        refreshPersonalBits(curId);
      }
    });
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
