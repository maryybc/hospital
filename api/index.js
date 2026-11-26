const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.HOSPITAL_DB_FILE ||
    path.join(__dirname, "../backend/db.json");
const sessions = new Map();
const MEDICAL_ROLES = ["medico", "admin"];
const STOCK_ROLES = ["almoxarifado", "admin"];
const READ_STOCK_ROLES = [...MEDICAL_ROLES, ...STOCK_ROLES];
const USER_ROLES = ["admin", "almoxarifado", "atendimento", "medico", "triagem"];

app.use(cors({ origin: process.env.APP_ORIGIN || false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../frontend")));

function readDB() {
    let data;

    if (!fs.existsSync(DB_FILE)) {
        data = {};
    } else {
        data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    }

    for (const key of ["usuarios", "pacientes", "triagens", "consultas",
        "medicamentos", "movimentacoes"]) {
        if (!Array.isArray(data[key])) data[key] = [];
    }

    return data;
}

function writeDB(data) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const temporaryFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temporaryFile, DB_FILE);
}

function hashSenha(senha, salt = crypto.randomBytes(16).toString("hex")) {
    return {
        senhaSalt: salt,
        senhaHash: crypto.scryptSync(senha, salt, 64).toString("hex")
    };
}

function verificarSenha(usuario, senha, db) {
    if (typeof senha !== "string") return false;

    if (usuario.senhaHash && usuario.senhaSalt) {
        const hashArmazenado = Buffer.from(usuario.senhaHash, "hex");
        if (hashArmazenado.length !== 64) return false;
        const hashInformado = crypto.scryptSync(
            senha, usuario.senhaSalt, hashArmazenado.length);
        return crypto.timingSafeEqual(hashArmazenado, hashInformado);
    }

    if (usuario.senha !== senha) return false;

    Object.assign(usuario, hashSenha(senha));
    delete usuario.senha;
    writeDB(db);
    return true;
}

function novoId() {
    return crypto.randomBytes(16).toString("hex");
}

function normalizarNome(nome) {
    return String(nome || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function quantidadeDisponivel(medicamento, hoje = new Date().toISOString().slice(0, 10)) {
    return (medicamento.lotes || []).reduce((total, lote) =>
        lote.validade >= hoje ? total + Number(lote.quantidade || 0) : total, 0);
}

function vistaEstoque(medicamento) {
    const hoje = new Date().toISOString().slice(0, 10);
    const lotes = medicamento.lotes || [];
    const quantidade = quantidadeDisponivel(medicamento, hoje);
    const expirados = lotes.filter(lote => lote.validade < hoje);
    const vencimentoProximo = lotes
        .filter(lote => lote.validade >= hoje)
        .map(lote => lote.validade)
        .sort()[0] || null;

    return {
        ...medicamento,
        lotes: lotes.map(lote => ({ ...lote })),
        quantidade,
        quantidadeTotal: lotes.reduce((total, lote) =>
            total + Number(lote.quantidade || 0), 0),
        quantidadeVencida: expirados.reduce((total, lote) =>
            total + Number(lote.quantidade || 0), 0),
        proximoVencimento: vencimentoProximo,
        disponivel: medicamento.ativo !== false && quantidade > 0
    };
}

function exigirPerfis(...perfis) {
    return (req, res, next) => {
        const cabecalho = req.get("authorization") || "";
        const token = cabecalho.startsWith("Bearer ")
            ? cabecalho.slice(7)
            : "";
        const sessao = sessions.get(token);

        if (!sessao || sessao.expiresAt <= Date.now()) {
            sessions.delete(token);
            return res.status(401).json({ erro: "Sessão inválida ou expirada. Entre novamente." });
        }

        if (!perfis.includes(sessao.usuario.tipo)) {
            return res.status(403).json({ erro: "Seu perfil não tem permissão para esta operação." });
        }

        req.usuario = sessao.usuario;
        next();
    };
}

function registrarMovimentacao(db, dados, usuario) {
    const movimentacao = {
        id: novoId(),
        ...dados,
        responsavel: usuario.usuario,
        perfil: usuario.tipo,
        createdAt: new Date().toISOString()
    };
    db.movimentacoes.push(movimentacao);
    return movimentacao;
}

function encontrarMedicamento(db, id) {
    return db.medicamentos.find(item => String(item.id) === String(id));
}

function validarLote(lote, validade) {
    return typeof lote === "string" && lote.trim().length > 0 &&
        lote.trim().length <= 80 &&
        typeof validade === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(validade) &&
        !Number.isNaN(Date.parse(`${validade}T00:00:00`)) &&
        new Date(`${validade}T00:00:00`).toISOString().slice(0, 10) === validade;
}

function validarQuantidade(valor) {
    return Number.isSafeInteger(Number(valor)) && Number(valor) > 0;
}

function adicionarLote(medicamento, lote, validade, quantidade) {
    const atual = medicamento.lotes.find(item =>
        item.lote.toLowerCase() === lote.trim().toLowerCase() &&
        item.validade === validade
    );

    if (atual) {
        atual.quantidade += quantidade;
        return atual;
    }

    const novoLote = {
        id: novoId(),
        lote: lote.trim(),
        validade,
        quantidade
    };
    medicamento.lotes.push(novoLote);
    return novoLote;
}

function erroInterno(res, contexto, erro) {
    console.error(`${contexto}:`, erro);
    return res.status(500).json({ erro: "Erro interno ao processar a solicitação." });
}

app.get("/status", (req, res) => {
    res.json({ funcionando: true, mensagem: "Servidor conectado com sucesso!" });
});

app.post("/login", (req, res) => {
    try {
        const { usuario, senha } = req.body || {};
        if (!usuario || !senha) {
            return res.status(400).json({ erro: "Informe usuário e senha." });
        }

        const db = readDB();
        const encontrado = db.usuarios.find(item =>
            item.usuario === String(usuario).trim());

        if (!encontrado || encontrado.ativo === false ||
            !verificarSenha(encontrado, senha, db)) {
            return res.status(401).json({ erro: "Login inválido." });
        }

        const token = crypto.randomBytes(32).toString("hex");
        const usuarioSeguro = {
            usuario: encontrado.usuario,
            tipo: encontrado.tipo
        };
        sessions.set(token, {
            usuario: usuarioSeguro,
            expiresAt: Date.now() + 8 * 60 * 60 * 1000
        });

        return res.json({ sucesso: true, token, usuario: usuarioSeguro });
    } catch (erro) {
        return erroInterno(res, "Erro no login", erro);
    }
});

app.post("/logout", (req, res) => {
    const token = (req.get("authorization") || "").replace(/^Bearer\s+/, "");
    sessions.delete(token);
    res.json({ sucesso: true });
});

app.get("/usuarios", exigirPerfis("admin"), (req, res) => {
    try {
        const usuarios = readDB().usuarios.map(usuario => ({
            usuario: usuario.usuario,
            tipo: usuario.tipo,
            ativo: usuario.ativo !== false,
            createdAt: usuario.createdAt || null,
            criadoPor: usuario.criadoPor || null,
            updatedAt: usuario.updatedAt || null,
            atualizadoPor: usuario.atualizadoPor || null
        }));
        return res.json(usuarios);
    } catch (erro) {
        return erroInterno(res, "Erro ao listar usuários", erro);
    }
});

app.post("/usuarios", exigirPerfis("admin"), (req, res) => {
    try {
        const { usuario, senha, tipo } = req.body || {};
        const nomeUsuario = typeof usuario === "string" ? usuario.trim() : "";
        if (!/^[a-zA-Z0-9._-]{3,40}$/.test(nomeUsuario)) {
            return res.status(400).json({
                erro: "O usuário deve ter de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado."
            });
        }
        if (typeof senha !== "string" || senha.length < 12) {
            return res.status(400).json({
                erro: "A senha deve ter pelo menos 12 caracteres."
            });
        }
        if (!USER_ROLES.includes(tipo)) {
            return res.status(400).json({ erro: "Selecione um perfil válido." });
        }

        const db = readDB();
        if (db.usuarios.some(item =>
            normalizarNome(item.usuario) === normalizarNome(nomeUsuario))) {
            return res.status(409).json({ erro: "Este usuário já está cadastrado." });
        }

        const novoUsuario = {
            usuario: nomeUsuario,
            tipo,
            ativo: true,
            ...hashSenha(senha),
            createdAt: new Date().toISOString(),
            criadoPor: req.usuario.usuario
        };
        db.usuarios.push(novoUsuario);
        writeDB(db);

        return res.status(201).json({
            sucesso: true,
            mensagem: "Usuário cadastrado com sucesso.",
            usuario: {
                usuario: novoUsuario.usuario,
                tipo: novoUsuario.tipo,
                ativo: novoUsuario.ativo,
                createdAt: novoUsuario.createdAt,
                criadoPor: novoUsuario.criadoPor
            }
        });
    } catch (erro) {
        return erroInterno(res, "Erro ao cadastrar usuário", erro);
    }
});

app.patch("/usuarios/:usuario", exigirPerfis("admin"), (req, res) => {
    try {
        const alteracoes = req.body || {};
        const camposPermitidos = ["tipo", "senha", "ativo"];
        const camposRecebidos = Object.keys(alteracoes);
        if (camposRecebidos.length === 0 ||
            camposRecebidos.some(campo => !camposPermitidos.includes(campo))) {
            return res.status(400).json({ erro: "Informe alterações válidas para o usuário." });
        }
        if (Object.hasOwn(alteracoes, "tipo") &&
            !USER_ROLES.includes(alteracoes.tipo)) {
            return res.status(400).json({ erro: "Selecione um perfil válido." });
        }
        if (Object.hasOwn(alteracoes, "senha") &&
            (typeof alteracoes.senha !== "string" || alteracoes.senha.length < 12)) {
            return res.status(400).json({
                erro: "A nova senha deve ter pelo menos 12 caracteres."
            });
        }
        if (Object.hasOwn(alteracoes, "ativo") &&
            typeof alteracoes.ativo !== "boolean") {
            return res.status(400).json({ erro: "O estado ativo deve ser verdadeiro ou falso." });
        }

        const db = readDB();
        const usuarioAlvo = db.usuarios.find(item =>
            normalizarNome(item.usuario) === normalizarNome(req.params.usuario));
        if (!usuarioAlvo) {
            return res.status(404).json({ erro: "Usuário não encontrado." });
        }

        const tipoNovo = Object.hasOwn(alteracoes, "tipo")
            ? alteracoes.tipo
            : usuarioAlvo.tipo;
        const ativoNovo = Object.hasOwn(alteracoes, "ativo")
            ? alteracoes.ativo
            : usuarioAlvo.ativo !== false;
        const eraAdminAtivo = usuarioAlvo.tipo === "admin" &&
            usuarioAlvo.ativo !== false;
        const continuaAdminAtivo = tipoNovo === "admin" && ativoNovo;

        if (normalizarNome(usuarioAlvo.usuario) ===
            normalizarNome(req.usuario.usuario) && !ativoNovo) {
            return res.status(409).json({
                erro: "Não é permitido desativar a própria conta."
            });
        }
        if (eraAdminAtivo && !continuaAdminAtivo &&
            db.usuarios.filter(item =>
                item.tipo === "admin" && item.ativo !== false).length <= 1) {
            return res.status(409).json({
                erro: "Não é possível desativar ou rebaixar o último administrador ativo."
            });
        }

        usuarioAlvo.tipo = tipoNovo;
        usuarioAlvo.ativo = ativoNovo;
        if (Object.hasOwn(alteracoes, "senha")) {
            Object.assign(usuarioAlvo, hashSenha(alteracoes.senha));
            delete usuarioAlvo.senha;
        }
        usuarioAlvo.updatedAt = new Date().toISOString();
        usuarioAlvo.atualizadoPor = req.usuario.usuario;
        writeDB(db);

        for (const [token, sessao] of sessions) {
            if (normalizarNome(sessao.usuario.usuario) ===
                normalizarNome(usuarioAlvo.usuario)) {
                sessions.delete(token);
            }
        }

        return res.json({
            sucesso: true,
            mensagem: "Usuário atualizado.",
            usuario: {
                usuario: usuarioAlvo.usuario,
                tipo: usuarioAlvo.tipo,
                ativo: usuarioAlvo.ativo,
                updatedAt: usuarioAlvo.updatedAt,
                atualizadoPor: usuarioAlvo.atualizadoPor
            }
        });
    } catch (erro) {
        return erroInterno(res, "Erro ao atualizar usuário", erro);
    }
});

app.post("/atendimento", (req, res) => {
    try {
        const { nome, cpf, tipo } = req.body || {};
        if (!nome || !String(nome).trim()) {
            return res.status(400).json({ erro: "O nome do paciente é obrigatório." });
        }

        const db = readDB();
        const paciente = {
            id: Date.now(),
            nome: String(nome).trim(),
            cpf: cpf || "",
            tipo: tipo || "",
            status: "triagem",
            createdAt: new Date().toISOString()
        };
        db.pacientes.push(paciente);
        writeDB(db);
        return res.status(201).json({
            sucesso: true,
            mensagem: "Paciente cadastrado com sucesso.",
            paciente
        });
    } catch (erro) {
        return erroInterno(res, "Erro no atendimento", erro);
    }
});

app.post("/triagem", (req, res) => {
    try {
        const {
            nome, sintoma, temperatura, alergia, observacao, risco, pacienteId
        } = req.body || {};
        if (!nome || !sintoma) {
            return res.status(400).json({ erro: "Nome e sintoma são obrigatórios." });
        }

        const db = readDB();
        let classificacao = risco || "verde";
        const temp = Number(temperatura);
        if (temperatura !== "" && temperatura != null && Number.isFinite(temp)) {
            if (temp >= 39) classificacao = "vermelho";
            else if (temp >= 38) classificacao = "amarelo";
        }

        const triagem = {
            id: Date.now(),
            pacienteId: pacienteId ?? null,
            nome,
            sintoma,
            temperatura: temperatura ?? "",
            alergia: alergia || "",
            observacao: observacao || "",
            risco: classificacao,
            status: "aguardando_medico",
            createdAt: new Date().toISOString()
        };
        db.triagens.push(triagem);

        if (pacienteId != null) {
            const paciente = db.pacientes.find(item =>
                String(item.id) === String(pacienteId));
            if (paciente) {
                paciente.triado = true;
                paciente.triagemConcluida = true;
                paciente.status = "triado";
            }
        }

        writeDB(db);
        return res.status(201).json({
            sucesso: true,
            mensagem: "Triagem salva com sucesso.",
            triagem
        });
    } catch (erro) {
        return erroInterno(res, "Erro na triagem", erro);
    }
});

app.get("/triagens", exigirPerfis(...MEDICAL_ROLES), (req, res) => {
    try {
        return res.json(readDB().triagens);
    } catch (erro) {
        return erroInterno(res, "Erro ao listar triagens", erro);
    }
});

app.get("/estoque", exigirPerfis(...READ_STOCK_ROLES), (req, res) => {
    try {
        const db = readDB();
        const estoque = db.medicamentos
            .map(vistaEstoque)
            .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
        return res.json(estoque);
    } catch (erro) {
        return erroInterno(res, "Erro ao carregar estoque", erro);
    }
});

app.get("/lista-medicacoes", exigirPerfis(...MEDICAL_ROLES), (req, res) => {
    try {
        const db = readDB();
        return res.json(db.medicamentos
            .map(vistaEstoque)
            .filter(item => item.disponivel)
            .map(item => item.nome));
    } catch (erro) {
        return erroInterno(res, "Erro ao carregar medicações", erro);
    }
});

app.post("/estoque", exigirPerfis(...STOCK_ROLES), (req, res) => {
    try {
        const { nome, quantidade, unidade, categoria, lote, validade } = req.body || {};
        const nomeMedicamento = typeof nome === "string" ? nome.trim() : "";

        if (!nomeMedicamento || nomeMedicamento.length > 120) {
            return res.status(400).json({ erro: "Informe um nome válido para o medicamento." });
        }
        if (!validarQuantidade(quantidade)) {
            return res.status(400).json({ erro: "A quantidade deve ser um inteiro maior que zero." });
        }
        if (!validarLote(lote, validade)) {
            return res.status(400).json({ erro: "Informe o lote e uma data de validade válida." });
        }

        const db = readDB();
        if (db.medicamentos.some(item =>
            normalizarNome(item.nome) === normalizarNome(nomeMedicamento))) {
            return res.status(409).json({
                erro: "Este medicamento já está cadastrado. Use a opção de reposição."
            });
        }

        const medicamento = {
            id: novoId(),
            nome: nomeMedicamento,
            categoria: String(categoria || "Geral").trim(),
            unidade: String(unidade || "unidades").trim(),
            ativo: true,
            lotes: [],
            createdAt: new Date().toISOString(),
            criadoPor: req.usuario.usuario
        };
        const novoLote = adicionarLote(
            medicamento, lote, validade, Number(quantidade));
        db.medicamentos.push(medicamento);
        registrarMovimentacao(db, {
            tipo: "entrada",
            medicamentoId: medicamento.id,
            medicamento: medicamento.nome,
            quantidade: Number(quantidade),
            unidade: medicamento.unidade,
            lote: novoLote.lote,
            validade: novoLote.validade,
            observacao: "Cadastro e entrada inicial",
            saldoAnterior: 0,
            saldoPosterior: quantidadeDisponivel(medicamento)
        }, req.usuario);
        writeDB(db);
        return res.status(201).json({
            sucesso: true,
            mensagem: "Medicamento cadastrado e entrada registrada.",
            medicamento: vistaEstoque(medicamento)
        });
    } catch (erro) {
        return erroInterno(res, "Erro ao cadastrar medicamento", erro);
    }
});

app.post("/estoque/:id/entradas", exigirPerfis(...STOCK_ROLES), (req, res) => {
    try {
        const { quantidade, lote, validade, observacao } = req.body || {};
        if (!validarQuantidade(quantidade)) {
            return res.status(400).json({ erro: "A quantidade deve ser um inteiro maior que zero." });
        }
        if (!validarLote(lote, validade)) {
            return res.status(400).json({ erro: "Informe o lote e uma data de validade válida." });
        }

        const db = readDB();
        const medicamento = encontrarMedicamento(db, req.params.id);
        if (!medicamento || medicamento.ativo === false) {
            return res.status(404).json({ erro: "Medicamento não encontrado ou arquivado." });
        }

        const saldoAnterior = quantidadeDisponivel(medicamento);
        const novoLote = adicionarLote(
            medicamento, lote, validade, Number(quantidade));
        registrarMovimentacao(db, {
            tipo: "entrada",
            medicamentoId: medicamento.id,
            medicamento: medicamento.nome,
            quantidade: Number(quantidade),
            unidade: medicamento.unidade,
            lote: novoLote.lote,
            validade: novoLote.validade,
            observacao: String(observacao || "").trim(),
            saldoAnterior,
            saldoPosterior: quantidadeDisponivel(medicamento)
        }, req.usuario);
        writeDB(db);
        return res.status(201).json({
            sucesso: true,
            mensagem: "Entrada registrada.",
            medicamento: vistaEstoque(medicamento)
        });
    } catch (erro) {
        return erroInterno(res, "Erro ao registrar entrada", erro);
    }
});

app.post("/estoque/:id/saidas", exigirPerfis(...STOCK_ROLES), (req, res) => {
    try {
        const { quantidade, paciente, prescricaoId, observacao } = req.body || {};
        if (!validarQuantidade(quantidade)) {
            return res.status(400).json({ erro: "A quantidade deve ser um inteiro maior que zero." });
        }
        if (!String(observacao || "").trim()) {
            return res.status(400).json({ erro: "Informe o motivo ou referência da saída." });
        }

        const db = readDB();
        const medicamento = encontrarMedicamento(db, req.params.id);
        if (!medicamento || medicamento.ativo === false) {
            return res.status(404).json({ erro: "Medicamento não encontrado ou arquivado." });
        }

        const quantidadeSaida = Number(quantidade);
        const saldoAnterior = quantidadeDisponivel(medicamento);
        if (quantidadeSaida > saldoAnterior) {
            return res.status(409).json({
                erro: `Estoque insuficiente. Disponível: ${saldoAnterior} ${medicamento.unidade}.`
            });
        }

        const hoje = new Date().toISOString().slice(0, 10);
        let restante = quantidadeSaida;
        const lotes = medicamento.lotes
            .filter(item => item.validade >= hoje && item.quantidade > 0)
            .sort((a, b) => a.validade.localeCompare(b.validade));
        const lotesBaixados = [];

        for (const lote of lotes) {
            const baixado = Math.min(restante, lote.quantidade);
            if (baixado > 0) {
                lote.quantidade -= baixado;
                restante -= baixado;
                lotesBaixados.push({ lote: lote.lote, validade: lote.validade, quantidade: baixado });
            }
            if (restante === 0) break;
        }

        if (restante !== 0) {
            return res.status(409).json({ erro: "Estoque insuficiente para concluir a saída." });
        }

        registrarMovimentacao(db, {
            tipo: "saida",
            medicamentoId: medicamento.id,
            medicamento: medicamento.nome,
            quantidade: quantidadeSaida,
            unidade: medicamento.unidade,
            lotes: lotesBaixados,
            paciente: String(paciente || "").trim(),
            prescricaoId: String(prescricaoId || "").trim(),
            observacao: String(observacao).trim(),
            saldoAnterior,
            saldoPosterior: quantidadeDisponivel(medicamento)
        }, req.usuario);
        writeDB(db);
        return res.status(201).json({
            sucesso: true,
            mensagem: "Saída registrada e estoque atualizado.",
            medicamento: vistaEstoque(medicamento)
        });
    } catch (erro) {
        return erroInterno(res, "Erro ao registrar saída", erro);
    }
});

app.delete("/estoque/:id", exigirPerfis(...STOCK_ROLES), (req, res) => {
    try {
        const db = readDB();
        const medicamento = encontrarMedicamento(db, req.params.id);
        if (!medicamento) {
            return res.status(404).json({ erro: "Medicamento não encontrado." });
        }
        const quantidadeTotal = (medicamento.lotes || []).reduce(
            (total, lote) => total + Number(lote.quantidade || 0), 0);
        if (quantidadeTotal > 0) {
            return res.status(409).json({
                erro: "Não é possível arquivar um medicamento que ainda possui unidades em lote."
            });
        }
        medicamento.ativo = false;
        medicamento.arquivadoPor = req.usuario.usuario;
        medicamento.arquivadoEm = new Date().toISOString();
        writeDB(db);
        return res.json({ sucesso: true, mensagem: "Medicamento arquivado." });
    } catch (erro) {
        return erroInterno(res, "Erro ao arquivar medicamento", erro);
    }
});

app.get("/movimentacoes", exigirPerfis(...STOCK_ROLES), (req, res) => {
    try {
        const movimentacoes = readDB().movimentacoes
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return res.json(movimentacoes);
    } catch (erro) {
        return erroInterno(res, "Erro ao carregar movimentações", erro);
    }
});

app.post("/consulta", exigirPerfis(...MEDICAL_ROLES), (req, res) => {
    try {
        const {
            paciente, diagnostico, medicacao, medicamentoId,
            quantidade, dosagem, frequencia, duracao, obs
        } = req.body || {};
        if (!String(paciente || "").trim()) {
            return res.status(400).json({ erro: "Informe o paciente." });
        }
        if (!String(dosagem || "").trim() ||
            !String(frequencia || "").trim() ||
            !String(duracao || "").trim()) {
            return res.status(400).json({
                erro: "Informe a dosagem, a frequência e a duração do tratamento."
            });
        }

        const db = readDB();
        const medicamento = medicamentoId
            ? encontrarMedicamento(db, medicamentoId)
            : db.medicamentos.find(item =>
                normalizarNome(item.nome) === normalizarNome(medicacao));

        if (!medicamento || medicamento.ativo === false) {
            return res.status(404).json({ erro: "Selecione um medicamento cadastrado e ativo." });
        }
        const quantidadePrescrita = quantidade == null || quantidade === ""
            ? 1
            : Number(quantidade);
        if (!validarQuantidade(quantidadePrescrita)) {
            return res.status(400).json({ erro: "A quantidade prescrita deve ser um inteiro maior que zero." });
        }

        const estoqueDisponivel = quantidadeDisponivel(medicamento);
        if (estoqueDisponivel === 0) {
            return res.status(409).json({ erro: "Medicamento indisponível: não há unidades válidas em estoque." });
        }

        const consulta = {
            id: novoId(),
            paciente: String(paciente).trim(),
            diagnostico: String(diagnostico || "").trim(),
            medicamentoId: medicamento.id,
            medicacao: medicamento.nome,
            quantidade: quantidadePrescrita,
            unidade: medicamento.unidade,
            dosagem: String(dosagem || "").trim(),
            frequencia: String(frequencia || "").trim(),
            duracao: String(duracao || "").trim(),
            estoqueDisponivel,
            estoqueInsuficiente: quantidadePrescrita > estoqueDisponivel,
            obs: String(obs || "").trim(),
            responsavel: req.usuario.usuario,
            perfil: req.usuario.tipo,
            createdAt: new Date().toISOString()
        };
        db.consultas.push(consulta);
        writeDB(db);
        return res.status(201).json({
            sucesso: true,
            mensagem: "Prescrição registrada. O estoque não foi alterado.",
            consulta
        });
    } catch (erro) {
        return erroInterno(res, "Erro ao salvar prescrição", erro);
    }
});

app.get("/medicacoes", exigirPerfis(...MEDICAL_ROLES), (req, res) => {
    try {
        return res.json(readDB().consultas
            .slice()
            .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))));
    } catch (erro) {
        return erroInterno(res, "Erro ao carregar prescrições", erro);
    }
});

app.use((req, res) => {
    res.status(404).json({ erro: "Rota não encontrada." });
});

app.use((erro, req, res, next) => {
    console.error("Erro no servidor:", erro);
    res.status(500).json({ erro: "Erro interno do servidor." });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Sistema hospitalar disponível em http://localhost:${PORT}`);
    });
}

module.exports = app;
