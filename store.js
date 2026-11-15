/* TheGadz Store — storefront app */
(function () {
  "use strict";

  var meta = document.querySelector('meta[name="api-base"]');
  var API_BASE = (meta && meta.content ? meta.content : "").replace(/\/+$/, "");

  var DEFAULT_TITLE = "TheGadz Store — Top Up Game & Voucher Murah, Aman, Cepat";
  var FEE_FALLBACK = 0.7;
  var STATUS_LABELS = {
    pending: "Menunggu pembayaran",
    paid: "Lunas",
    fulfilled: "Selesai",
    expired: "Kedaluwarsa",
    cancelled: "Dibatalkan"
  };
  var EVENT_LABELS = {
    created: "Pesanan dibuat",
    paid: "Pembayaran diterima",
    fulfilled: "Pesanan diproses",
    expired: "Pesanan kedaluwarsa",
    cancelled: "Pesanan dibatalkan"
  };

  var views = {
    home: document.getElementById("homeView"),
    category: document.getElementById("categoryView"),
    product: document.getElementById("productView"),
    order: document.getElementById("orderView"),
    track: document.getElementById("trackView"),
    info: document.getElementById("infoView"),
    missing: document.getElementById("missingView")
  };
  var rails = document.getElementById("rails");
  var catNav = document.getElementById("catNav");
  var searchForm = document.getElementById("searchForm");
  var searchInput = document.getElementById("searchInput");
  var toastEl = document.getElementById("toast");
  var menuBtn = document.getElementById("menuBtn");
  var drawer = document.getElementById("drawer");
  var drawerClose = document.getElementById("drawerClose");
  var drawerOverlay = document.getElementById("drawerOverlay");
  var newsTrack = document.getElementById("newsTrack");
  var newsPrev = document.getElementById("newsPrev");
  var newsNext = document.getElementById("newsNext");

  var state = {
    config: null,
    categories: [],
    products: [],
    bySlug: {},
    dataLoaded: false,
    route: null,
    dataPromise: null,
    viewToken: 0,
    pollTimer: null,
    countdownTimer: null,
    toastTimer: null,
    orderToken: 0
  };

  /* ---------------------------------------------------------------- helpers */

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function rupiah(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return "Rp" + n.toLocaleString("id-ID");
  }

  function pctLabel(value) {
    var n = Number(value);
    if (!isFinite(n)) n = FEE_FALLBACK;
    return n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
  }

  function safeColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : "#0f766e";
  }

  function shade(hex, amount) {
    var raw = safeColor(hex).slice(1);
    var num = parseInt(raw, 16);
    var r = Math.max(0, Math.min(255, ((num >> 16) & 255) + amount));
    var g = Math.max(0, Math.min(255, ((num >> 8) & 255) + amount));
    var b = Math.max(0, Math.min(255, (num & 255) + amount));
    return "#" + [r, g, b].map(function (part) {
      return part.toString(16).padStart(2, "0");
    }).join("");
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso);
    try {
      return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
    } catch (err) {
      return date.toLocaleString();
    }
  }

  function fmtShortDate(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" }).format(date);
    } catch (err) {
      return date.toLocaleDateString();
    }
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }

  function toast(message, isError) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.toggle("error", !!isError);
    toastEl.classList.add("show");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
    }, 3200);
  }

  function api(path, options) {
    var opts = options || {};
    var headers = {};
    if (opts.body) headers["content-type"] = "application/json";
    return fetch(API_BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (err) {
            data = {};
          }
        }
        if (!response.ok) {
          var error = new Error(data.message || "Permintaan gagal (" + response.status + ").");
          error.status = response.status;
          error.code = data.error;
          throw error;
        }
        return data;
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      /* ignore */
    }
    document.body.removeChild(area);
  }

  function clearTimers() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }

  function hideViews() {
    Object.keys(views).forEach(function (key) {
      if (views[key]) views[key].hidden = true;
    });
  }

  function showView(name) {
    hideViews();
    if (views[name]) views[name].hidden = false;
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function scrollToSection(id) {
    var target = document.getElementById(id);
    if (!target) return;
    var top = target.getBoundingClientRect().top + window.pageYOffset - 84;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  /* ---------------------------------------------------------------- data */

  function ensureData() {
    if (!state.dataPromise) {
      state.dataPromise = Promise.all([api("/api/config"), api("/api/catalog")]).then(function (results) {
        var config = results[0];
        var catalog = results[1];
        state.config = config || {};
        state.categories = (catalog && catalog.categories) || [];
        state.products = [];
        state.bySlug = {};
        state.categories.forEach(function (category) {
          (category.products || []).forEach(function (product) {
            product.category_slug = product.category_slug || category.slug;
            product.category_name = product.category_name || category.name;
            state.products.push(product);
            state.bySlug[product.slug] = product;
          });
        });
        state.dataLoaded = true;
        renderNav();
        return state;
      }).catch(function (error) {
        state.dataPromise = null;
        throw error;
      });
    }
    return state.dataPromise;
  }

  function feePercent() {
    if (state.config && state.config.qris && isFinite(Number(state.config.qris.fee_percent))) {
      return Number(state.config.qris.fee_percent);
    }
    return FEE_FALLBACK;
  }

  function demoEnabled() {
    return !!(state.config && (state.config.demo === true || state.config.demo === 1 || state.config.demo === "1"));
  }

  /* ---------------------------------------------------------------- nav */

  function renderNav() {
    if (!catNav) return;
    var html = '<a class="cat-chip" data-slug="" href="#/">Semua</a>';
    state.categories.forEach(function (category) {
      html += '<a class="cat-chip" data-slug="' + esc(category.slug) + '" href="#/kategori/' + esc(category.slug) + '">' +
        esc(category.name) + "</a>";
    });
    catNav.innerHTML = html;
    setActiveNav(state.route);
  }

  function setActiveNav(routeInfo) {
    if (!catNav) return;
    var activeSlug = "";
    if (routeInfo && routeInfo.name === "category") activeSlug = routeInfo.slug;
    Array.prototype.forEach.call(catNav.querySelectorAll(".cat-chip"), function (chip) {
      chip.classList.toggle("active", chip.getAttribute("data-slug") === activeSlug);
    });
  }

  /* ---------------------------------------------------------------- cards */

  function productCard(product) {
    var color = safeColor(product.color);
    return '<a class="product-card" href="#/produk/' + esc(product.slug) + '" title="' + esc(product.name) + '">' +
      '<span class="product-thumb" style="background:linear-gradient(150deg,' + color + "," + shade(color, -34) + ')">' +
        '<span class="thumb-icon">' + esc(product.icon || "🎮") + "</span>" +
      "</span>" +
      '<span class="product-name">' + esc(product.name) + "</span>" +
    "</a>";
  }

  function productGrid(products) {
    return '<div class="product-grid">' + products.map(productCard).join("") + "</div>";
  }

  /* ---------------------------------------------------------------- home */

  function renderHome() {
    if (!rails) return;
    if (state.categories.length) {
      rails.innerHTML = state.categories.map(function (category) {
        var products = category.products || [];
        return '<section class="store-section" id="kategori-' + esc(category.slug) + '">' +
          '<div class="section-head"><h2>' + esc(category.name) + '</h2>' +
            '<a class="section-more" href="#/kategori/' + esc(category.slug) + '">Lihat Semua</a></div>' +
          productGrid(products) +
          '<a class="section-cta" href="#/kategori/' + esc(category.slug) + '">Lihat Semua</a>' +
        "</section>";
      }).join("");
      return;
    }
    if (state.dataLoaded) {
      rails.innerHTML = '<div class="state-card"><span class="state-icon">🗂️</span><h2>Katalog belum tersedia</h2>' +
        "<p>Belum ada produk aktif. Silakan kembali lagi nanti.</p></div>";
      return;
    }
    rails.innerHTML = '<div class="loading-block">Memuat katalog…</div>';
    ensureData().then(function () {
      if (state.route && state.route.name === "home") renderHome();
    }).catch(function (error) {
      if (state.route && state.route.name === "home") {
        rails.innerHTML = catalogError(error);
      }
    });
  }

  function catalogError(error) {
    return '<div class="state-card">' +
      '<span class="state-icon">⚠️</span>' +
      "<h2>Katalog gagal dimuat</h2>" +
      "<p>" + esc(error && error.message ? error.message : "Periksa koneksi internet lalu coba lagi.") + "</p>" +
      '<button class="primary-btn" type="button" data-retry-catalog>Muat ulang</button>' +
    "</div>";
  }

  /* ---------------------------------------------------------------- category */

  function renderCategory(slug) {
    var view = views.category;
    var token = ++state.viewToken;
    view.innerHTML = '<div class="loading-block">Memuat produk…</div>';
    ensureData().then(function () {
      if (token !== state.viewToken) return;
      var category = state.categories.filter(function (item) {
        return item.slug === slug;
      })[0];
      if (!category) {
        document.title = "Halaman tidak ditemukan — TheGadz Store";
        showView("missing");
        return;
      }
      document.title = category.name + " — TheGadz Store";
      view.innerHTML =
        '<div class="view-head">' +
          '<nav class="crumb"><a href="#/">Beranda</a><span>/</span><span>' + esc(category.name) + "</span></nav>" +
          '<h1 class="page-title">' + esc(category.name) + "</h1>" +
          '<p class="page-sub">Pilih produk favoritmu, masukkan ID akun, lalu bayar dengan QRIS.</p>' +
        "</div>" +
        '<section class="panel">' +
          '<div class="section-head"><h2>' + esc(category.name) + '</h2>' +
            '<a class="section-more" href="#/">Semua Kategori</a></div>' +
          productGrid(category.products || []) +
        "</section>";
    }).catch(function (error) {
      if (token !== state.viewToken) return;
      view.innerHTML = catalogError(error);
    });
  }

  /* ---------------------------------------------------------------- search */

  function renderSearch(query) {
    var view = views.category;
    var token = ++state.viewToken;
    var q = String(query || "").trim();
    if (searchInput) searchInput.value = q;

    if (!state.dataLoaded) {
      view.innerHTML = '<div class="loading-block">Memuat katalog…</div>';
      ensureData().then(function () {
        if (token !== state.viewToken) return;
        if (!state.route || state.route.name !== "search") return;
        renderSearch(q);
      }).catch(function (error) {
        if (token !== state.viewToken) return;
        view.innerHTML = catalogError(error);
      });
      return;
    }

    var results = state.products.filter(function (product) {
      var haystack = [product.name, product.short, product.unit, product.category_name, product.slug].join(" ").toLowerCase();
      return haystack.indexOf(q.toLowerCase()) !== -1;
    });

    view.innerHTML =
      '<div class="view-head">' +
        '<nav class="crumb"><a href="#/">Beranda</a><span>/</span><span>Pencarian</span></nav>' +
        '<h1 class="page-title">Hasil pencarian “' + esc(q) + "”</h1>" +
        '<p class="page-sub">' + results.length + " produk ditemukan.</p>" +
      "</div>" +
      (results.length
        ? '<section class="panel">' + productGrid(results) + "</section>"
        : '<div class="state-card"><span class="state-icon">🔍</span><h2>Produk tidak ditemukan</h2>' +
          "<p>Coba kata kunci lain seperti “diamond”, “voucher”, atau “pulsa”.</p>" +
          '<a class="primary-btn" href="#/">Kembali ke beranda</a></div>');

    document.title = "Cari — TheGadz Store";
  }

  /* ---------------------------------------------------------------- product */

  function targetField(product) {
    if (product.target_type === "phone") {
      return { label: "Nomor HP", placeholder: "08xxxxxxxxxx", mode: "numeric", hint: "Masukkan nomor HP aktif yang terdaftar." };
    }
    if (product.target_type === "account") {
      return { label: "User ID / Email", placeholder: "USERID atau email", mode: "text", hint: "Masukkan User ID atau email akun tujuan." };
    }
    return { label: "Player ID", placeholder: "Masukkan Player ID", mode: "numeric", hint: "Masukkan Player ID tanpa spasi." };
  }

  function validateTargetLocal(product, playerId, zoneId) {
    if (product.target_type === "phone") {
      if (!/^\d{8,15}$/.test(playerId)) return "Nomor HP harus 8–15 angka.";
    } else if (product.target_type === "account") {
      if (!/^[A-Za-z0-9._@+\-]{3,60}$/.test(playerId)) return "User ID / email tidak valid (3–60 karakter).";
    } else if (!/^\d{5,20}$/.test(playerId)) {
      return "Player ID harus 5–20 angka.";
    }
    if (product.requires_zone && !/^\d{1,6}$/.test(zoneId)) {
      return "Zone ID wajib diisi 1–6 angka.";
    }
    return "";
  }

  function renderProduct(slug) {
    var view = views.product;
    var token = ++state.viewToken;
    view.innerHTML = '<div class="loading-block">Memuat produk…</div>';
    ensureData().catch(function () {
      return null;
    });

    api("/api/products/" + encodeURIComponent(slug)).then(function (data) {
      try {
      if (token !== state.viewToken) return;
      var product = data.product;
      var denominations = data.denominations || [];
      if (!denominations.length) {
        view.innerHTML = '<div class="state-card"><span class="state-icon">📦</span><h2>Nominal belum tersedia</h2>' +
          "<p>Produk ini belum memiliki nominal aktif. Coba lagi nanti.</p>" +
          '<a class="primary-btn" href="#/">Kembali ke beranda</a></div>';
        return;
      }

      document.title = product.name + " — TheGadz Store";
      var color = safeColor(product.color);
      var tf = targetField(product);
      var selected = denominations[0];

      var denomHtml = denominations.map(function (denomination) {
        return '<button type="button" class="denom' + (denomination.id === selected.id ? " selected" : "") + '"' +
          ' data-denom-id="' + esc(denomination.id) + '"' +
          ' data-price="' + esc(denomination.price) + '"' +
          ' data-label="' + esc(denomination.label) + '">' +
          '<span class="denom-label">' + esc(denomination.label) + "</span>" +
          '<span class="denom-price">' + rupiah(denomination.price) + "</span>" +
          (Number(denomination.compare_at) > Number(denomination.price)
            ? '<span class="denom-old">' + rupiah(denomination.compare_at) + "</span>"
            : "") +
        "</button>";
      }).join("");

      view.innerHTML =
        '<div class="view-head">' +
          '<nav class="crumb"><a href="#/">Beranda</a><span>/</span>' +
            '<a href="#/kategori/' + esc(product.category_slug) + '">' + esc(product.category_name) + "</a><span>/</span>" +
            "<span>" + esc(product.name) + "</span></nav>" +
        "</div>" +
        '<div class="product-layout">' +
          '<div class="product-main">' +
            '<section class="product-hero" style="--soft:' + color + '22">' +
              '<div class="product-hero-icon" style="background:linear-gradient(150deg,' + color + "," + shade(color, -34) + ')">' +
                esc(product.icon || "🎮") + "</div>" +
              '<div class="product-hero-body">' +
                '<span class="eyebrow">' + esc(product.category_name) + "</span>" +
                "<h1>" + esc(product.name) + "</h1>" +
                "<p>" + esc(product.description || "Top up cepat, aman, dan harga transparan.") + "</p>" +
                '<div class="product-badges">' +
                  '<span class="badge green">⚡ Proses instan</span>' +
                  '<span class="badge">🔒 QRIS</span>' +
                  (product.requires_zone ? '<span class="badge">Zone ID diperlukan</span>' : "") +
                "</div>" +
              "</div>" +
            "</section>" +

            '<section class="form-panel">' +
              '<h2><span class="step-dot">1</span> Masukkan data akun</h2>' +
              '<p class="form-hint">' + esc(tf.hint) + " Pastikan data benar — pesanan yang sudah diproses tidak dapat dibatalkan.</p>" +
              '<div class="' + (product.requires_zone ? "field-row" : "") + '">' +
                '<div class="field"><label for="playerId">' + esc(tf.label) + " <span style=\"color:#b91c1c\">*</span></label>" +
                  '<input id="playerId" type="text" inputmode="' + tf.mode + '" maxlength="60" autocomplete="off" placeholder="' + esc(tf.placeholder) + '" /></div>' +
                (product.requires_zone
                  ? '<div class="field"><label for="zoneId">Zone ID / Server <span style="color:#b91c1c">*</span></label>' +
                    '<input id="zoneId" type="text" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="Contoh: 1234" /></div>'
                  : "") +
              "</div>" +
              '<div class="field"><label for="nickname">Nickname <small>(opsional)</small></label>' +
                '<input id="nickname" type="text" maxlength="40" autocomplete="off" placeholder="Nama karakter / akun" /></div>' +
              '<p class="field-error" id="fieldError" hidden></p>' +
            "</section>" +

            '<section class="denom-panel">' +
              '<h2><span class="step-dot">2</span> Pilih nominal</h2>' +
              '<p class="form-hint">Harga sudah termasuk pajak. Biaya QRIS ditampilkan di ringkasan.</p>' +
              '<div class="denom-grid" id="denomGrid">' + denomHtml + "</div>" +
            "</section>" +
          "</div>" +

          '<aside class="summary-card">' +
            '<h2>Ringkasan Pesanan</h2>' +
            '<div class="summary-product">' +
              '<span class="summary-product-icon" style="background:linear-gradient(150deg,' + color + "," + shade(color, -34) + ')">' + esc(product.icon || "🎮") + "</span>" +
              "<div><b>" + esc(product.name) + "</b><small>" + esc(product.unit || product.category_name) + "</small></div>" +
            "</div>" +
            '<div class="summary-row"><span>Nominal</span><span id="sumDenom">' + esc(selected.label) + "</span></div>" +
            '<div class="summary-row"><span>Harga</span><span id="sumSubtotal">' + rupiah(selected.price) + "</span></div>" +
            '<div class="summary-row muted"><span>Biaya QRIS (' + pctLabel(feePercent()) + '%)</span><span id="sumFee">' + rupiah(Math.round(Number(selected.price) * feePercent() / 100)) + "</span></div>" +
            '<div class="summary-total"><span>Total bayar</span><b id="sumTotal">' + rupiah(Number(selected.price) + Math.round(Number(selected.price) * feePercent() / 100)) + "</b></div>" +
            '<button class="buy-btn" type="button" id="buyBtn">Beli Sekarang</button>' +
            '<div class="pay-note">🔒 <span><b>Pembayaran QRIS.</b> QR otomatis dibuat sesuai total pesanan. Tidak perlu transfer manual.</span></div>' +
          "</aside>" +
        "</div>";

      var current = { denomination: selected };

      var grid = document.getElementById("denomGrid");
      grid.addEventListener("click", function (event) {
        var button = event.target.closest("[data-denom-id]");
        if (!button) return;
        Array.prototype.forEach.call(grid.querySelectorAll(".denom"), function (item) {
          item.classList.toggle("selected", item === button);
        });
        current.denomination = {
          id: Number(button.getAttribute("data-denom-id")),
          price: Number(button.getAttribute("data-price")),
          label: button.getAttribute("data-label")
        };
        document.getElementById("sumDenom").textContent = current.denomination.label;
        document.getElementById("sumSubtotal").textContent = rupiah(current.denomination.price);
        var fee = Math.round(current.denomination.price * feePercent() / 100);
        document.getElementById("sumFee").textContent = rupiah(fee);
        document.getElementById("sumTotal").textContent = rupiah(current.denomination.price + fee);
      });

      var buyBtn = document.getElementById("buyBtn");
      buyBtn.addEventListener("click", function () {
        var errorEl = document.getElementById("fieldError");
        var playerId = document.getElementById("playerId").value.trim();
        var zoneEl = document.getElementById("zoneId");
        var zoneId = zoneEl ? zoneEl.value.trim() : "";
        var nickname = document.getElementById("nickname").value.trim();

        errorEl.hidden = true;
        var validation = validateTargetLocal(product, playerId, zoneId);
        if (validation) {
          errorEl.textContent = validation;
          errorEl.hidden = false;
          toast(validation, true);
          return;
        }

        buyBtn.disabled = true;
        buyBtn.textContent = "Memproses pesanan…";
        api("/api/orders", {
          method: "POST",
          body: {
            product_slug: product.slug,
            denomination_id: current.denomination.id,
            player_id: playerId,
            zone_id: zoneId,
            nickname: nickname
          }
        }).then(function (result) {
          var order = result.order;
          rememberOrder(order);
          toast("Pesanan " + order.public_id + " berhasil dibuat.");
          go("#/pesanan/" + order.public_id);
        }).catch(function (error) {
          buyBtn.disabled = false;
          buyBtn.textContent = "Beli Sekarang";
          errorEl.textContent = error.message;
          errorEl.hidden = false;
          toast(error.message, true);
        });
      });
      } catch (renderErr) {
        console.error("renderProduct failed", renderErr);
        view.innerHTML = '<div class="state-card"><span class="state-icon">⚠️</span><h2>Gagal menampilkan produk</h2>' +
          "<p>" + (renderErr && renderErr.message ? esc(renderErr.message) : "Terjadi kesalahan.") + "</p>" +
          '<a class="primary-btn" href="#/">Kembali ke beranda</a></div>';
      }
    }).catch(function (error) {
      if (token !== state.viewToken) return;
      if (error.status === 404) {
        document.title = "Produk tidak ditemukan — TheGadz Store";
        view.innerHTML = '<div class="state-card"><span class="state-icon">🧭</span><h2>Produk tidak ditemukan</h2>' +
          "<p>Produk yang kamu cari tidak tersedia atau sudah tidak aktif.</p>" +
          '<a class="primary-btn" href="#/">Kembali ke beranda</a></div>';
      } else {
        view.innerHTML = '<div class="state-card"><span class="state-icon">⚠️</span><h2>Gagal memuat produk</h2>' +
          "<p>" + (error && error.message ? esc(error.message) : "Terjadi kesalahan.") + "</p>" +
          '<a class="primary-btn" href="#/">Kembali ke beranda</a></div>';
      }
    });
  }

  /* ---------------------------------------------------------------- order */

  function rememberOrder(order) {
    if (!order || !order.public_id) return;
    try {
      var key = "gadz_orders";
      var list = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(list)) list = [];
      list = list.filter(function (item) {
        return item && item.id !== order.public_id;
      });
      list.unshift({
        id: order.public_id,
        product: order.product_name,
        total: order.total,
        created_at: order.created_at
      });
      localStorage.setItem(key, JSON.stringify(list.slice(0, 8)));
    } catch (err) {
      /* storage may be unavailable */
    }
  }

  function recentOrders() {
    try {
      var list = JSON.parse(localStorage.getItem("gadz_orders") || "[]");
      return Array.isArray(list) ? list.filter(function (item) {
        return item && /^TG[A-Z0-9]{6,12}$/.test(String(item.id || ""));
      }) : [];
    } catch (err) {
      return [];
    }
  }

  function orderTargetText(order) {
    return order.player_id + (order.zone_id ? " · Zone " + order.zone_id : "");
  }

  function statusBadge(status) {
    return '<span class="status-badge ' + esc(status) + '">' + esc(STATUS_LABELS[status] || status) + "</span>";
  }

  function orderPaySection(order) {
    if (order.status === "pending") {
      return '<div class="qr-wrap">' +
        '<div class="qr-box"><div class="qr-code" id="orderQr"></div></div>' +
        '<p class="qr-amount">Total pembayaran<b>' + rupiah(order.total) + "</b></p>" +
        '<div class="countdown" id="orderCountdown">Menghitung…</div>' +
        '<div class="qr-steps">' +
          "<b>Cara bayar</b>" +
          "<span>1. Buka aplikasi bank atau e-wallet yang mendukung QRIS.</span>" +
          "<span>2. Scan QR di atas, lalu periksa nominal sebelum membayar.</span>" +
          "<span>3. Konfirmasi pembayaran. Status pesanan diperbarui otomatis.</span>" +
        "</div>" +
        (demoEnabled()
          ? '<div class="demo-note"><b>Mode demo aktif.</b> Gateway QRIS asli belum terhubung. Gunakan tombol di bawah untuk mensimulasikan pembayaran berhasil.</div>' +
            '<button class="demo-btn" type="button" id="demoPaidBtn" data-demo="' + esc(order.public_id) + '">Simulasikan Pembayaran Berhasil</button>'
          : "") +
      "</div>";
    }
    if (order.status === "paid") {
      return '<div class="order-success"><span class="big-icon">✅</span><h3>Pembayaran diterima</h3>' +
        "<p>Pesanan sedang diproses. Halaman ini diperbarui otomatis.</p></div>" +
        '<div class="order-help">Simpan ID pesanan <b>' + esc(order.public_id) + "</b> untuk melacak status. " +
        'Proses biasanya selesai dalam beberapa menit.</div>';
    }
    if (order.status === "fulfilled") {
      return '<div class="order-success"><span class="big-icon">🎉</span><h3>Pesanan selesai</h3>' +
        "<p>Pesanan sudah diproses dan dikirim ke tujuan.</p>" +
        (order.supplier_ref ? '<p style="margin-top:6px">Ref: <b>' + esc(order.supplier_ref) + "</b></p>" : "") +
        "</div>" +
        '<div class="order-help">Terima kasih sudah berbelanja di TheGadz Store. ' +
        'Butuh bantuan? Hubungi admin dengan menyertakan ID pesanan.</div>';
    }
    if (order.status === "expired") {
      return '<div class="order-success" style="background:#fff7ed;border-color:#fed7aa">' +
        '<span class="big-icon">⌛</span><h3>Pesanan kedaluwarsa</h3>' +
        "<p>Batas waktu pembayaran sudah lewat. Silakan buat pesanan baru.</p></div>" +
        '<a class="primary-btn" style="width:100%;margin-top:12px" href="#/produk/' + esc(order.product_slug) + '">Buat pesanan baru</a>';
    }
    return '<div class="order-success" style="background:#f8faf9;border-color:#e2e8e4">' +
      '<span class="big-icon">🚫</span><h3>Pesanan dibatalkan</h3>' +
      "<p>Pesanan ini dibatalkan oleh admin.</p></div>" +
      '<a class="primary-btn" style="width:100%;margin-top:12px" href="#/produk/' + esc(order.product_slug) + '">Pesan lagi</a>';
  }

  function renderOrder(id, options) {
    var opts = options || {};
    var view = views.order;
    var token = ++state.orderToken;
    if (!opts.silent) view.innerHTML = '<div class="loading-block">Memuat pesanan…</div>';

    api("/api/orders/" + encodeURIComponent(id)).then(function (data) {
      if (token !== state.orderToken || !state.route || state.route.name !== "order" || state.route.id !== id) return;
      var order = data.order;
      rememberOrder(order);
      document.title = "Pesanan " + order.public_id + " — TheGadz Store";

      var events = order.events || [];
      var timeline = events.length
        ? '<ul class="timeline">' + events.map(function (event) {
            return '<li class="timeline-item"><b>' + esc(EVENT_LABELS[event.type] || event.type) + "</b>" +
              (event.message ? "<p>" + esc(event.message) + "</p>" : "") +
              "<small>" + fmtDateTime(event.created_at) + "</small></li>";
          }).join("") + "</ul>"
        : '<p class="page-sub">Belum ada riwayat.</p>';

      view.innerHTML =
        '<div class="view-head">' +
          '<nav class="crumb"><a href="#/">Beranda</a><span>/</span>' +
            '<a href="#/lacak">Lacak</a><span>/</span><span>' + esc(order.public_id) + "</span></nav>" +
          '<div class="order-title-row"><h1 class="page-title">Pesanan <span class="order-id">' + esc(order.public_id) + "</span>" +
            '<button class="copy-btn" type="button" data-copy="' + esc(order.public_id) + '" aria-label="Salin ID pesanan">⧉</button></h1>' +
            statusBadge(order.status) + "</div>" +
          '<p class="page-sub">Dibuat ' + fmtDateTime(order.created_at) + " · Pembayaran QRIS</p>" +
        "</div>" +
        '<div class="order-layout">' +
          '<section class="order-card">' + orderPaySection(order) + "</section>" +
          '<section class="order-card">' +
            '<h2 class="card-title">Detail Pesanan</h2>' +
            '<dl class="detail-list">' +
              '<div class="detail-row"><dt>Produk</dt><dd><a href="#/produk/' + esc(order.product_slug) + '">' + esc(order.product_name) + "</a></dd></div>" +
              '<div class="detail-row"><dt>Nominal</dt><dd>' + esc(order.denomination_label) + "</dd></div>" +
              '<div class="detail-row"><dt>Tujuan</dt><dd>' + esc(orderTargetText(order)) + "</dd></div>" +
              (order.nickname && order.nickname !== "Player"
                ? '<div class="detail-row"><dt>Nickname</dt><dd>' + esc(order.nickname) + "</dd></div>"
                : "") +
              '<div class="detail-row"><dt>Harga</dt><dd>' + rupiah(order.subtotal) + "</dd></div>" +
              '<div class="detail-row"><dt>Biaya QRIS</dt><dd>' + rupiah(order.fee) + "</dd></div>" +
              '<div class="detail-row total"><dt>Total</dt><dd>' + rupiah(order.total) + "</dd></div>" +
              '<div class="detail-row"><dt>Metode</dt><dd>QRIS</dd></div>' +
              (order.paid_at ? '<div class="detail-row"><dt>Dibayar</dt><dd>' + fmtDateTime(order.paid_at) + "</dd></div>" : "") +
              (order.fulfilled_at ? '<div class="detail-row"><dt>Selesai</dt><dd>' + fmtDateTime(order.fulfilled_at) + "</dd></div>" : "") +
            "</dl>" +
            '<h2 class="card-title" style="margin-top:22px">Riwayat Pesanan</h2>' + timeline +
            '<div class="order-help">Simpan halaman ini atau catat ID pesanan <b>' + esc(order.public_id) +
              "</b> untuk melacak status. Butuh bantuan? Hubungi admin dengan menyertakan ID pesanan.</div>" +
          "</section>" +
        "</div>";

      if (order.status === "pending") {
        paintQr(document.getElementById("orderQr"), order.qr_payload);
        startCountdown(order, id);
      }
      if (order.status === "pending" || order.status === "paid") {
        if (state.pollTimer) clearTimeout(state.pollTimer);
        state.pollTimer = setTimeout(function () {
          if (state.route && state.route.name === "order" && state.route.id === id) {
            renderOrder(id, { silent: true });
          }
        }, order.status === "pending" ? 6000 : 8000);
      }
      if (!state.config) {
        ensureData().then(function () {
          if (token === state.orderToken && state.route && state.route.name === "order" && state.route.id === id) {
            renderOrder(id, { silent: true });
          }
        }).catch(function () {
          /* keep the order visible with fallback settings */
        });
      }
    }).catch(function (error) {
      if (token !== state.orderToken) return;
      if (opts.silent) {
        if (state.pollTimer) clearTimeout(state.pollTimer);
        state.pollTimer = setTimeout(function () {
          if (state.route && state.route.name === "order" && state.route.id === id) {
            renderOrder(id, { silent: true });
          }
        }, 10000);
        return;
      }
      if (error.status === 404) {
        view.innerHTML = '<div class="state-card"><span class="state-icon">🧭</span><h2>Pesanan tidak ditemukan</h2>' +
          "<p>Periksa kembali ID pesanan. ID biasanya diawali <b>TG</b>.</p>" +
          '<a class="primary-btn" href="#/lacak">Lacak pesanan</a></div>';
      } else {
        view.innerHTML = '<div class="state-card"><span class="state-icon">⚠️</span><h2>Gagal memuat pesanan</h2>' +
          "<p>" + esc(error.message) + "</p>" +
          '<a class="primary-btn" href="#/lacak">Coba lagi</a></div>';
      }
    });
  }

  function paintQr(container, payload) {
    if (!container) return;
    container.innerHTML = "";
    if (!payload) {
      container.innerHTML = '<span class="qr-fallback">QR belum tersedia.</span>';
      return;
    }
    if (typeof window.qrcode !== "function") {
      container.innerHTML = '<span class="qr-fallback">' + esc(payload) + "</span>";
      return;
    }
    try {
      var qr = window.qrcode(0, "M");
      qr.addData(payload, "Byte");
      qr.make();
      container.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, alt: "QR pembayaran QRIS" });
    } catch (error) {
      container.innerHTML = '<span class="qr-fallback">' + esc(payload) + "</span>";
    }
  }

  function startCountdown(order, id) {
    var el = document.getElementById("orderCountdown");
    if (!el) return;
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    var expires = Date.parse(order.expires_at);
    var refreshed = false;

    function tick() {
      if (!el.isConnected) {
        clearInterval(state.countdownTimer);
        return;
      }
      var remaining = expires - Date.now();
      if (remaining <= 0) {
        el.classList.add("expired");
        el.textContent = "Waktu pembayaran habis";
        clearInterval(state.countdownTimer);
        if (!refreshed) {
          refreshed = true;
          setTimeout(function () {
            if (state.route && state.route.name === "order" && state.route.id === id) {
              renderOrder(id, { silent: true });
            }
          }, 800);
        }
        return;
      }
      el.textContent = "Bayar dalam " + formatDuration(remaining);
    }

    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  function handleDemoPaid(button) {
    var id = button.getAttribute("data-demo");
    if (!id) return;
    button.disabled = true;
    button.textContent = "Memproses pembayaran…";
    api("/api/orders/" + encodeURIComponent(id) + "/demo-paid", { method: "POST" }).then(function () {
      toast("Pembayaran demo berhasil. Pesanan lunas.");
      renderOrder(id, { silent: true });
    }).catch(function (error) {
      button.disabled = false;
      button.textContent = "Simulasikan Pembayaran Berhasil";
      toast(error.message, true);
    });
  }

  /* ---------------------------------------------------------------- tracking */

  function renderTrack() {
    var view = views.track;
    var recent = recentOrders();
    var recentHtml = recent.length
      ? '<div class="recent-list">' + recent.map(function (item) {
          return '<a class="recent-item" href="#/pesanan/' + esc(item.id) + '">' +
            "<div><b>" + esc(item.id) + "</b><small>" + esc(item.product || "Pesanan") + " · " + fmtShortDate(item.created_at) + "</small></div>" +
            '<span class="amount">' + rupiah(item.total) + "</span>" +
          "</a>";
        }).join("") + "</div>"
      : '<div class="recent-empty">Belum ada pesanan di perangkat ini. Pesanan yang kamu buat akan muncul di sini.</div>';

    view.innerHTML =
      '<div class="view-head">' +
        '<nav class="crumb"><a href="#/">Beranda</a><span>/</span><span>Lacak Pesanan</span></nav>' +
      "</div>" +
      '<div class="track-layout">' +
        '<section class="track-card">' +
          "<h1>Lacak pesanan</h1>" +
          "<p>Masukkan ID pesanan yang kamu terima setelah checkout untuk melihat status pembayaran dan prosesnya.</p>" +
          '<form class="track-form" id="trackForm" novalidate>' +
            '<input id="trackInput" type="text" autocomplete="off" spellcheck="false" maxlength="20" placeholder="Contoh: TGK3M9XQ2" aria-label="ID pesanan" />' +
            '<button type="submit">Lacak</button>' +
          "</form>" +
          '<p class="track-error" id="trackError" hidden></p>' +
          '<div class="order-help" style="margin-top:16px">ID pesanan terdiri dari <b>TG</b> diikuti huruf dan angka, contoh <b>TGK3M9XQ2</b>. ' +
            "Jika kamu kehilangan ID, hubungi admin dengan bukti pembayaran.</div>" +
        "</section>" +
        '<section class="recent-card"><h2>Pesanan terakhir</h2>' + recentHtml + "</section>" +
      "</div>";
    document.title = "Lacak Pesanan — TheGadz Store";
  }

  /* ---------------------------------------------------------------- info pages */

  var INFO_PAGES = {
    bantuan: {
      title: "Cara Top Up & Pembayaran",
      body:
        "<h2>Cara top up</h2>" +
        "<ol>" +
          "<li>Pilih kategori dan produk yang ingin dibeli dari halaman beranda.</li>" +
          "<li>Masukkan Player ID, User ID, atau nomor HP tujuan beserta Zone ID jika diminta.</li>" +
          "<li>Pilih nominal, lalu periksa ringkasan harga dan biaya QRIS.</li>" +
          "<li>Tekan <b>Beli Sekarang</b> untuk membuat pesanan.</li>" +
          "<li>Scan QR QRIS dengan aplikasi bank atau e-wallet, lalu bayar sesuai nominal.</li>" +
          "<li>Status pesanan diperbarui otomatis. Simpan ID pesanan untuk melacak.</li>" +
        "</ol>" +
        "<h2>Pembayaran QRIS</h2>" +
        "<p>TheGadz Store hanya menerima pembayaran QRIS. Satu QR untuk satu pesanan, dan nominalnya sudah termasuk biaya layanan QRIS yang ditampilkan sebelum kamu membayar.</p>" +
        '<p class="info-note">Pesanan yang belum dibayar sampai batas waktu akan otomatis kedaluwarsa. Buat pesanan baru jika waktunya habis.</p>' +
        "<h2>Butuh bantuan?</h2>" +
        '<p>Hubungi kami di <a href="mailto:support@thegadz.store">support@thegadz.store</a> dengan menyertakan ID pesanan dan bukti pembayaran.</p>'
    },
    tentang: {
      title: "Tentang Kami",
      body:
        "<h2>TheGadz Store</h2>" +
        "<p>TheGadz Store adalah toko digital untuk top up game, live app, voucher, pulsa, dan saldo e-money. Semua harga ditampilkan dalam Rupiah dan pembayaran dilakukan lewat QRIS.</p>" +
        "<h2>Yang kami sediakan</h2>" +
        "<ul>" +
          "<li>Top Up Game: Mobile Legends, Free Fire, PUBG Mobile, Valorant, dan lainnya.</li>" +
          "<li>Top Up Live Apps: Bigo Live, Poppo Live, Mico Live, dan aplikasi populer lain.</li>" +
          "<li>Voucher: Steam, Google Play, PSN, Roblox, dan voucher digital lain.</li>" +
          "<li>Pulsa dan E-Money: semua operator besar serta dompet digital utama.</li>" +
        "</ul>" +
        "<h2>Kontak</h2>" +
        '<p>Email: <a href="mailto:support@thegadz.store">support@thegadz.store</a></p>'
    },
    privasi: {
      title: "Kebijakan Privasi",
      body:
        "<h2>Data yang kami kumpulkan</h2>" +
        "<p>Kami hanya menyimpan data yang diperlukan untuk memproses pesanan: ID tujuan (Player ID, User ID, atau nomor HP), Zone ID bila diperlukan, dan nickname opsional.</p>" +
        "<h2>Penggunaan data</h2>" +
        "<ul>" +
          "<li>Memproses dan mengirim pesanan ke tujuan yang kamu masukkan.</li>" +
          "<li>Menampilkan status pesanan dan riwayat transaksi untuk keperluan bantuan.</li>" +
          "<li>Mencegah penyalahgunaan dan penipuan.</li>" +
        "</ul>" +
        "<h2>Penyimpanan</h2>" +
        "<p>ID pesanan terakhir disimpan di perangkatmu (localStorage) agar mudah dilacak. Data pembayaran kartu atau saldo tidak pernah kami simpan karena pembayaran dilakukan lewat QRIS di aplikasi pembayaranmu.</p>" +
        "<h2>Pihak ketiga</h2>" +
        "<p>Data tujuan pesanan dapat diteruskan ke penyedia layanan top up terkait semata-mata untuk menyelesaikan pesanan.</p>" +
        '<p class="info-note">Pertanyaan privasi: <a href="mailto:support@thegadz.store">support@thegadz.store</a></p>'
    },
    syarat: {
      title: "Syarat & Ketentuan",
      body:
        "<h2>Ketentuan umum</h2>" +
        "<p>Dengan membuat pesanan di TheGadz Store, kamu setuju untuk memberikan data tujuan yang benar dan membayar sesuai nominal yang tertera.</p>" +
        "<h2>Pesanan</h2>" +
        "<ul>" +
          "<li>Pesanan diproses setelah pembayaran QRIS terkonfirmasi.</li>" +
          "<li>Data tujuan yang salah menjadi tanggung jawab pembeli.</li>" +
          "<li>Nominal dan harga dapat berubah sewaktu-waktu sebelum pesanan dibuat.</li>" +
          "<li>Pesanan yang belum dibayar sampai batas waktu akan kedaluwarsa otomatis.</li>" +
        "</ul>" +
        "<h2>Larangan</h2>" +
        "<p>Dilarang menggunakan layanan ini untuk aktivitas penipuan, pencucian uang, atau pelanggaran hukum lain. Kami berhak membatalkan pesanan yang mencurigakan.</p>"
    },
    refund: {
      title: "Kebijakan Refund",
      body:
        "<h2>Kapan refund diberikan</h2>" +
        "<ul>" +
          "<li>Pesanan sudah dibayar tetapi tidak dapat diproses oleh penyedia layanan.</li>" +
          "<li>Terjadi pembayaran ganda untuk satu pesanan yang sama.</li>" +
          "<li>Kesalahan sistem yang membuat pesanan gagal diproses.</li>" +
        "</ul>" +
        "<h2>Kapan refund tidak diberikan</h2>" +
        "<ul>" +
          "<li>Pesanan sudah berhasil dikirim ke tujuan.</li>" +
          "<li>Data tujuan salah karena kesalahan pembeli.</li>" +
          "<li>Akun tujuan dalam status diblokir atau dibatasi pihak game/aplikasi.</li>" +
        "</ul>" +
        "<h2>Proses refund</h2>" +
        "<p>Hubungi <a href=\"mailto:support@thegadz.store\">support@thegadz.store</a> dengan ID pesanan dan bukti pembayaran maksimal 3x24 jam setelah transaksi. Refund yang disetujui dikembalikan melalui QRIS atau transfer ke rekening yang kamu sebutkan, maksimal 7 hari kerja.</p>"
    }
  };

  function renderInfo(slug) {
    var view = views.info;
    var page = INFO_PAGES[slug];
    if (!page) {
      showView("missing");
      document.title = "Halaman tidak ditemukan — TheGadz Store";
      return;
    }
    document.title = page.title + " — TheGadz Store";
    var links = Object.keys(INFO_PAGES).map(function (key) {
      return '<a href="#/info/' + esc(key) + '"' + (key === slug ? ' class="active"' : "") + ">" +
        esc(INFO_PAGES[key].title) + "</a>";
    }).join("");
    view.innerHTML =
      '<div class="view-head">' +
        '<nav class="crumb"><a href="#/">Beranda</a><span>/</span><span>' + esc(page.title) + "</span></nav>" +
      "</div>" +
      '<div class="info-layout">' +
        '<section class="info-card">' +
          "<h1>" + esc(page.title) + "</h1>" +
          page.body +
        "</section>" +
        '<aside class="info-card"><h2>Informasi</h2><nav class="info-nav">' + links + "</nav></aside>" +
      "</div>";
    showView("info");
  }

  /* ---------------------------------------------------------------- drawer + news */

  function openDrawer() {
    if (!drawer) return;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    if (drawerOverlay) {
      drawerOverlay.hidden = false;
      drawerOverlay.classList.add("show");
    }
    document.body.classList.add("drawer-open");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "true");
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    if (drawerOverlay) {
      drawerOverlay.classList.remove("show");
      drawerOverlay.hidden = true;
    }
    document.body.classList.remove("drawer-open");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  }

  function newsStep(dir) {
    if (!newsTrack) return;
    var card = newsTrack.querySelector(".news-card");
    var distance = card ? card.getBoundingClientRect().width + 12 : Math.round(newsTrack.clientWidth * 0.8);
    newsTrack.scrollBy({ left: dir * distance, behavior: "smooth" });
  }

  /* ---------------------------------------------------------------- routing */

  function parseRoute() {
    var raw = location.hash || "#/";
    if (raw.charAt(0) === "#" && raw.charAt(1) !== "/") {
      var plain = raw.slice(1);
      if (!plain) return { name: "home" };
      if (plain === "cara-top-up") return { name: "home", anchor: "cara-top-up" };
      return { name: "category", slug: decode(plain) };
    }

    var path = raw.replace(/^#/, "");
    var query = {};
    var qIndex = path.indexOf("?");
    if (qIndex !== -1) {
      path.slice(qIndex + 1).split("&").forEach(function (pair) {
        if (!pair) return;
        var parts = pair.split("=");
        query[decode(parts.shift())] = decode(parts.join("="));
      });
      path = path.slice(0, qIndex);
    }

    var parts = path.split("/").filter(Boolean);
    if (!parts.length) return { name: "home" };
    if (parts[0] === "kategori" && parts[1]) return { name: "category", slug: decode(parts[1]) };
    if (parts[0] === "produk" && parts[1]) return { name: "product", slug: decode(parts[1]) };
    if (parts[0] === "pesanan" && parts[1]) return { name: "order", id: decode(parts[1]).toUpperCase() };
    if (parts[0] === "lacak") return { name: "track" };
    if (parts[0] === "info") return { name: "info", slug: decode(parts[1] || "") };
    if (parts[0] === "cari") return { name: "search", q: query.q || "" };
    return { name: "missing" };
  }

  function decode(value) {
    try {
      return decodeURIComponent(value || "");
    } catch (err) {
      return String(value || "");
    }
  }

  function route() {
    clearTimers();
    state.orderToken++;
    closeDrawer();
    var info = parseRoute();
    state.route = info;
    setActiveNav(info);
    hideViews();
    window.scrollTo({ top: 0, behavior: "auto" });

    if (info.name === "home") {
      showView("home");
      document.title = DEFAULT_TITLE;
      renderHome();
      if (info.anchor) {
        setTimeout(function () {
          scrollToSection(info.anchor);
        }, 60);
      }
      return;
    }

    if (info.name === "category") {
      showView("category");
      document.title = "Kategori — TheGadz Store";
      renderCategory(info.slug);
      return;
    }

    if (info.name === "search") {
      showView("category");
      renderSearch(info.q);
      return;
    }

    if (info.name === "product") {
      showView("product");
      document.title = "Produk — TheGadz Store";
      renderProduct(info.slug);
      return;
    }

    if (info.name === "order") {
      showView("order");
      document.title = "Pesanan — TheGadz Store";
      renderOrder(info.id);
      return;
    }

    if (info.name === "track") {
      showView("track");
      renderTrack();
      return;
    }

    if (info.name === "info") {
      renderInfo(info.slug);
      return;
    }

    showView("missing");
    document.title = "Halaman tidak ditemukan — TheGadz Store";
  }

  /* ---------------------------------------------------------------- events */

  if (searchForm) {
    searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var q = searchInput ? searchInput.value.trim() : "";
      if (!q) {
        if (searchInput) searchInput.focus();
        return;
      }
      go("#/cari?q=" + encodeURIComponent(q));
    });
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || form.id !== "trackForm") return;
    event.preventDefault();
    var input = document.getElementById("trackInput");
    var errorEl = document.getElementById("trackError");
    var value = (input ? input.value : "").trim().toUpperCase().replace(/\s+/g, "");
    if (!/^TG[A-Z0-9]{6,12}$/.test(value)) {
      if (errorEl) {
        errorEl.textContent = "ID pesanan tidak valid. Contoh: TGK3M9XQ2";
        errorEl.hidden = false;
      }
      if (input) input.focus();
      return;
    }
    go("#/pesanan/" + value);
  });

  document.addEventListener("click", function (event) {
    var copyBtn = event.target.closest("[data-copy]");
    if (copyBtn) {
      copyText(copyBtn.getAttribute("data-copy")).then(function () {
        toast("ID pesanan disalin.");
      });
      return;
    }

    var demoBtn = event.target.closest("[data-demo]");
    if (demoBtn) {
      handleDemoPaid(demoBtn);
      return;
    }

    var retry = event.target.closest("[data-retry-catalog]");
    if (retry) {
      state.dataPromise = null;
      if (state.route && state.route.name === "home") renderHome();
      else route();
      return;
    }

    var helpLink = event.target.closest('a[href="#cara-top-up"]');
    if (helpLink && state.route && state.route.name === "home") {
      var target = document.getElementById("cara-top-up");
      if (target) {
        event.preventDefault();
        scrollToSection("cara-top-up");
        if (history.replaceState) history.replaceState(null, "", "#cara-top-up");
      }
    }
  });

  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      if (drawer && drawer.classList.contains("open")) closeDrawer();
      else openDrawer();
    });
  }

  if (drawerClose) drawerClose.addEventListener("click", closeDrawer);
  if (drawerOverlay) drawerOverlay.addEventListener("click", closeDrawer);

  if (newsPrev) newsPrev.addEventListener("click", function () { newsStep(-1); });
  if (newsNext) newsNext.addEventListener("click", function () { newsStep(1); });

  if (catNav) {
    catNav.addEventListener("click", function (event) {
      if (event.target.closest("a")) closeDrawer();
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" || event.key === "Esc") closeDrawer();
  });

  window.addEventListener("hashchange", route);

  /* ---------------------------------------------------------------- boot */

  route();
  ensureData().catch(function () {
    /* view-level error states handle this */
  });
})();
