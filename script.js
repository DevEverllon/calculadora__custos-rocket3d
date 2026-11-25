"use strict";

// =====================================================
// REGRAS DE CÁLCULO (funções puras, sem acesso ao DOM)
// =====================================================
const PADRAO = {
  precoKg: 110, // filamento (R$/kg)
  precoKwh: 1.07, // energia (R$/kWh)
  consumoWatts: 150, // impressora (W)
  depreciacaoHora: 0.6, // R$/h
  maoObraHora: 20, // R$/h (só entra se houver pós-processamento)
  falhaPct: 0, // % sobre material + energia + depreciação
  taxaVendaPct: 0, // % sobre o preço de venda
};
const MARGENS = [50, 100, 150];
// Valores de referência: ajuste conforme o que você paga
const MATERIAIS = { PLA: 110, PETG: 120, ABS: 120, TPU: 150, Resina: 200 };

const formatadorMoeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const moeda = (v) => formatadorMoeda.format(v);
const pct = (v) => `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

function calcularLote(d, cfg) {
  const q = d.qtd;
  const horas = d.tempoMin / 60;
  const material = ((d.peso * cfg.precoKg) / 1000) * q;
  const energia = (cfg.consumoWatts / 1000) * horas * cfg.precoKwh * q;
  const depreciacao = cfg.depreciacaoHora * horas * q;
  const maoObra = (d.posMin / 60) * cfg.maoObraHora * q;
  const falhas = ((material + energia + depreciacao) * cfg.falhaPct) / 100;
  const adicional = d.adicional * q + d.frete;
  const itens = { material, energia, depreciacao, maoObra, falhas, adicional };
  const total = Object.values(itens).reduce((a, b) => a + b, 0);
  return { ...itens, total, porUnidade: total / q };
}

function calcularPreco(total, qtd, margem, taxaPct) {
  const venda = total * (1 + margem / 100);
  const taxa = (venda * taxaPct) / 100;
  return { margem, venda, porUnidade: venda / qtd, taxa, lucro: venda - taxa - total };
}

// =====================================================
// DOM
// =====================================================
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- armazenamento seguro ----------
const guardar = (k, v) => {
  try { localStorage.setItem("rocket3d:" + k, JSON.stringify(v)); } catch { /* ignora */ }
};
const ler = (k, fallback) => {
  try {
    const v = localStorage.getItem("rocket3d:" + k);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
};
const escapeHtml = (t) =>
  String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- avisos (toast) ----------
function toast(msg, tipo = "success") {
  const el = document.createElement("div");
  el.className = `toast toast--${tipo}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("toast--hide"), 2500);
  setTimeout(() => el.remove(), 2900);
}

// ---------- estado ----------
let cfg = { ...PADRAO, ...ler("cfg", {}) };
let historico = ler("historico", []);
let ultimo = null;

const resultado = $(".result-container");

// Identifica um cálculo (dados + configurações) para impedir duplicados no histórico
const assinatura = (dados) => JSON.stringify({ dados, cfg });
const jaSalvo = () => Boolean(ultimo) && historico.some((h) => h.assinatura === assinatura(ultimo.dados));
const CAMPOS = ["nome", "peso", "tempoH", "tempoM", "qtd", "pos", "adicional", "frete", "margem"];

// ---------- tema ----------
function aplicarTema(t) {
  document.documentElement.dataset.theme = t;
  guardar("tema", t);
}
aplicarTema(ler("tema", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("#tema").addEventListener("click", () =>
  aplicarTema(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
);

// ---------- configurações e material ----------
const selMaterial = $("#material");
selMaterial.innerHTML =
  Object.keys(MATERIAIS).map((m) => `<option value="${m}">${m}</option>`).join("") +
  `<option value="custom">Personalizado</option>`;

function sincronizarConfig() {
  $$("[data-cfg]").forEach((i) => (i.value = cfg[i.dataset.cfg]));
  const achado = Object.keys(MATERIAIS).find((m) => MATERIAIS[m] === cfg.precoKg);
  selMaterial.value = achado || "custom";
}

selMaterial.addEventListener("change", () => {
  if (selMaterial.value !== "custom") {
    cfg.precoKg = MATERIAIS[selMaterial.value];
    guardar("cfg", cfg);
    sincronizarConfig();
    atualizar();
  }
});

$$("[data-cfg]").forEach((input) =>
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (v >= 0) {
      cfg[input.dataset.cfg] = v;
      guardar("cfg", cfg);
      if (input.dataset.cfg === "precoKg") sincronizarConfig_material();
      atualizar();
    }
  }),
);
function sincronizarConfig_material() {
  selMaterial.value = Object.keys(MATERIAIS).find((m) => MATERIAIS[m] === cfg.precoKg) || "custom";
}

$("#restaurar").addEventListener("click", () => {
  cfg = { ...PADRAO };
  guardar("cfg", cfg);
  sincronizarConfig();
  atualizar();
});

// ---------- leitura e validação ----------
const lerNum = (id) => {
  const t = $("#" + id).value.trim().replace(",", ".");
  return t === "" ? null : Number(t);
};

function lerDados() {
  const peso = lerNum("peso");
  const h = lerNum("tempoH") ?? 0;
  const m = lerNum("tempoM") ?? 0;
  const qtd = lerNum("qtd");
  const opc = (id) => lerNum(id);
  const erros = {};

  if (!(peso > 0)) erros.peso = "Informe o peso da peça em gramas";
  if (!(h >= 0 && m >= 0 && h * 60 + m > 0)) erros.tempo = "Informe o tempo de impressão (horas e/ou minutos)";
  if (!(qtd >= 1 && Number.isInteger(qtd))) erros.qtd = "Informe uma quantidade inteira (mínimo 1)";
  for (const id of ["pos", "adicional", "frete", "margem"]) {
    const v = opc(id);
    if (v !== null && !(v >= 0)) erros[id] = "O valor não pode ser negativo";
  }

  return {
    erros,
    dados: {
      nome: $("#nome").value.trim(),
      peso, qtd,
      tempoMin: h * 60 + m,
      posMin: opc("pos") ?? 0,
      adicional: opc("adicional") ?? 0,
      frete: opc("frete") ?? 0,
      margem: opc("margem"), // null = não informada
    },
  };
}

function mostrarErros(erros) {
  ["peso", "tempo", "qtd", "pos", "adicional", "frete", "margem"].forEach((k) => {
    $("#erro-" + k).textContent = erros[k] || "";
    (k === "tempo" ? ["tempoH", "tempoM"] : [k]).forEach((id) =>
      $("#" + id).classList.toggle("input-erro", Boolean(erros[k])),
    );
  });
}

// ---------- atualização ----------
function atualizar(exibirErros = false) {
  const { dados, erros } = lerDados();
  const invalido = Object.keys(erros).length > 0;
  mostrarErros(exibirErros ? erros : {});

  if (invalido) {
    ultimo = null;
    resultado.innerHTML = "";
    if (exibirErros) {
      const k = ["peso", "tempo", "qtd", "pos", "adicional", "frete", "margem"].find((x) => erros[x]);
      $("#" + (k === "tempo" ? "tempoH" : k)).focus();
    }
    return;
  }

  const lote = calcularLote(dados, cfg);
  const margens = dados.margem === null ? MARGENS : [...MARGENS, dados.margem];
  const precos = margens.map((m) => calcularPreco(lote.total, dados.qtd, m, cfg.taxaVendaPct));
  ultimo = { dados, lote, precos };
  renderizar();
}

// ---------- renderização ----------
const LINHAS = [
  ["material", "fa-weight-scale", "Material"],
  ["energia", "fa-bolt", "Energia"],
  ["depreciacao", "fa-screwdriver-wrench", "Depreciação"],
  ["maoObra", "fa-hand", "Mão de obra"],
  ["falhas", "fa-triangle-exclamation", "Falhas"],
  ["adicional", "fa-plus", "Adicional / frete"],
];

function renderizar() {
  const { dados: d, lote, precos } = ultimo;

  const titulos = LINHAS.map(([, ic, nome]) => `<li><i class="fa-solid ${ic}" aria-hidden="true"></i> ${nome}:</li>`).join("");
  const valores = LINHAS.map(([k]) => `<li>${moeda(lote[k])}</li>`).join("");

  const barra = LINHAS.map(
    ([k], i) => `<span class="seg c${i}" style="width:${(lote[k] / lote.total) * 100}%" title="${LINHAS[i][2]}: ${pct((lote[k] / lote.total) * 100)}"></span>`,
  ).join("");
  const legenda = LINHAS.filter(([k]) => lote[k] > 0)
    .map(([k, , nome]) => `<span><i class="dot c${LINHAS.findIndex((l) => l[0] === k)}"></i>${nome} ${pct((lote[k] / lote.total) * 100)}</span>`)
    .join("");

  const cards = precos
    .map((p, i) => {
      const custom = i >= MARGENS.length;
      return `
      <article class="card-preco ${custom ? "card-custom" : ""}">
        <h3>${custom ? "Personalizada " : ""}+${pct(p.margem)}</h3>
        <p class="valor">${moeda(p.venda)}</p>
        ${d.qtd > 1 ? `<p class="muted">${moeda(p.porUnidade)} por unidade</p>` : ""}
        <p class="lucro ${p.lucro < 0 ? "negativo" : ""}">Lucro líquido: <b>${moeda(p.lucro)}</b></p>
        ${cfg.taxaVendaPct > 0 ? `<p class="muted">Taxa de venda: ${moeda(p.taxa)}</p>` : ""}
        <button type="button" class="btn-secondary" data-copiar="${i}"><i class="fa-regular fa-copy" aria-hidden="true"></i> Copiar orçamento</button>
      </article>`;
    })
    .join("");

  resultado.innerHTML = `
    ${d.nome ? `<h2 class="peca">${escapeHtml(d.nome)} <small>× ${d.qtd}</small></h2>` : ""}
    <div class="container-info">
      <div class="list">
        <ul class="container-info-title">${titulos}</ul>
        <ul class="container-info-result">${valores}</ul>
      </div>
      <div class="price">
        <i class="fa-solid fa-coins" aria-hidden="true"></i>
        <p><b>Custo total${d.qtd > 1 ? " do lote" : ""}:</b></p>
        <p class="price-total">${moeda(lote.total)}</p>
        ${d.qtd > 1 ? `<p class="muted">${moeda(lote.porUnidade)} por unidade</p>` : ""}
      </div>
    </div>

    <div class="composicao" aria-label="Composição do custo">
      <div class="barra">${barra}</div>
      <div class="legenda">${legenda}</div>
    </div>

    <hr class="hr" />
    <div class="cards">${cards}</div>
    <div class="actions">${
      jaSalvo()
        ? `<button type="button" id="salvar" class="btn-secondary" disabled><i class="fa-solid fa-check" aria-hidden="true"></i> Já salvo no histórico</button>`
        : `<button type="button" id="salvar" class="btn-secondary"><i class="fa-regular fa-floppy-disk" aria-hidden="true"></i> Salvar no histórico</button>`
    }</div>
    <hr class="hr" />`;
}

// ---------- copiar orçamento / salvar ----------
function textoOrcamento(i) {
  const { dados: d, precos } = ultimo;
  const p = precos[i];
  return [
    "Orçamento - Rocket 3D Maker",
    d.nome && `Peça: ${d.nome}`,
    `Quantidade: ${d.qtd}`,
    d.qtd > 1 && `Valor unitário: ${moeda(p.porUnidade)}`,
    `Valor total: ${moeda(p.venda)}`,
  ].filter(Boolean).join("\n");
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = texto;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

resultado.addEventListener("click", async (e) => {
  const btnCopiar = e.target.closest("[data-copiar]");
  if (btnCopiar && ultimo) {
    await copiar(textoOrcamento(Number(btnCopiar.dataset.copiar)));
    toast("Orçamento copiado!");
  }
  if (e.target.closest("#salvar") && ultimo) {
    if (jaSalvo()) {
      toast("Esse cálculo já está salvo no histórico.", "warning");
      return;
    }
    const campos = Object.fromEntries(CAMPOS.map((id) => [id, $("#" + id).value]));
    historico = [
      {
        id: Date.now(),
        data: new Date().toISOString(),
        nome: ultimo.dados.nome,
        qtd: ultimo.dados.qtd,
        total: ultimo.lote.total,
        assinatura: assinatura(ultimo.dados),
        campos,
      },
      ...historico,
    ].slice(0, 20);
    guardar("historico", historico);
    renderHistorico();
    renderizar(); // atualiza o botão para "Já salvo"
    toast("Cálculo salvo no histórico!");
  }
});

// ---------- histórico ----------
function renderHistorico() {
  $("#historico-vazio").hidden = historico.length > 0;
  $("#limpar-historico").hidden = historico.length === 0;
  $("#lista-historico").innerHTML = historico
    .map(
      (h) => `
      <li>
        <div>
          <b>${escapeHtml(h.nome || "Sem nome")}</b> <span class="muted">× ${h.qtd}</span>
          <div class="muted">${new Date(h.data).toLocaleDateString("pt-BR")} · custo ${moeda(h.total)}</div>
        </div>
        <div class="row">
          <button type="button" class="btn-secondary" data-acao="carregar" data-id="${h.id}">Carregar</button>
          <button type="button" class="btn-secondary" data-acao="remover" data-id="${h.id}" aria-label="Remover">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </button>
        </div>
      </li>`,
    )
    .join("");
}

$("#lista-historico").addEventListener("click", (e) => {
  const b = e.target.closest("[data-acao]");
  if (!b) return;
  const item = historico.find((h) => h.id === Number(b.dataset.id));
  if (!item) return;
  if (b.dataset.acao === "remover") {
    historico = historico.filter((h) => h !== item);
    guardar("historico", historico);
    renderHistorico();
    if (ultimo) renderizar();
  } else {
    CAMPOS.forEach((id) => ($("#" + id).value = item.campos[id] ?? ""));
    atualizar(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

$("#limpar-historico").addEventListener("click", () => {
  if (confirm("Apagar todo o histórico?")) {
    historico = [];
    guardar("historico", historico);
    renderHistorico();
    if (ultimo) renderizar();
  }
});

// ---------- formulário ----------
$("#form-calculo").addEventListener("submit", (e) => {
  e.preventDefault();
  atualizar(true);
  resultado.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#form-calculo").addEventListener("input", () => atualizar(false)); // cálculo automático

$("#limpar").addEventListener("click", () => {
  CAMPOS.forEach((id) => ($("#" + id).value = ""));
  $("#qtd").value = 1;
  atualizar();
  $("#peso").focus();
});

// ---------- início ----------
sincronizarConfig();
renderHistorico();
