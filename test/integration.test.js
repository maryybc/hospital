const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { after, before, test } = require("node:test");

const diretorioTemporario = fs.mkdtempSync(
    path.join(os.tmpdir(), "hospital-system-test-")
);
const arquivoBanco = path.join(diretorioTemporario, "db.json");
process.env.HOSPITAL_DB_FILE = arquivoBanco;

fs.writeFileSync(arquivoBanco, JSON.stringify({
    usuarios: [
        { usuario: "medico-teste", senha: "senha-teste", tipo: "medico" },
        { usuario: "almox-teste", senha: "senha-teste", tipo: "almoxarifado" },
        { usuario: "triagem-teste", senha: "senha-teste", tipo: "triagem" },
        { usuario: "admin-teste", senha: "senha-teste", tipo: "admin" }
    ],
    pacientes: [],
    triagens: [],
    consultas: []
}), "utf8");

const app = require("../api");
let servidor;
let baseUrl;

before(async () => {
    servidor = app.listen(0);
    await new Promise(resolve => servidor.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
    if (servidor) {
        await new Promise((resolve, reject) =>
            servidor.close(erro => erro ? reject(erro) : resolve()));
    }
    fs.rmSync(diretorioTemporario, { recursive: true, force: true });
});

async function requisitar(caminho, opcoes = {}) {
    const headers = { ...(opcoes.headers || {}) };
    if (opcoes.token) headers.Authorization = `Bearer ${opcoes.token}`;
    if (opcoes.body) headers["Content-Type"] = "application/json";
    const resposta = await fetch(`${baseUrl}${caminho}`, {
        method: opcoes.method || "GET",
        headers,
        body: opcoes.body ? JSON.stringify(opcoes.body) : undefined
    });
    const data = await resposta.json();
    return { status: resposta.status, data };
}

async function entrar(usuario, senha = "senha-teste") {
    const resposta = await requisitar("/login", {
        method: "POST",
        body: { usuario, senha }
    });
    assert.equal(resposta.status, 200);
    assert.ok(resposta.data.token);
    assert.equal(resposta.data.usuario.senha, undefined);
    const conta = JSON.parse(fs.readFileSync(arquivoBanco, "utf8"))
        .usuarios.find(item => item.usuario === usuario);
    assert.equal(conta.senha, undefined);
    assert.match(conta.senhaHash, /^[a-f0-9]{128}$/);
    return resposta.data.token;
}

function dataFutura(dias) {
    return new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
}

test("atalho Ctrl+Alt+A navega ao painel admin a partir dos módulos", () => {
    const codigoAtalho = fs.readFileSync(
        path.join(__dirname, "../frontend/admin-shortcut.js"), "utf8");
    let manipuladorTeclado;
    let destino;
    let prevenido = false;
    const janela = {
        location: {
            pathname: "/medico.html",
            assign(url) {
                destino = url;
            }
        },
        addEventListener(evento, manipulador) {
            assert.equal(evento, "keydown");
            manipuladorTeclado = manipulador;
        }
    };

    vm.runInNewContext(codigoAtalho, {
        URL,
        document: { baseURI: "http://localhost:3000/medico.html" },
        window: janela
    });

    manipuladorTeclado({
        ctrlKey: true,
        altKey: true,
        code: "KeyA",
        key: "å",
        repeat: false,
        preventDefault() {
            prevenido = true;
        }
    });
    assert.equal(prevenido, true);
    assert.equal(destino, "http://localhost:3000/admin.html");
});

test("integra estoque, prescrição e dispensação com controle de perfil", async () => {
    const paginas = [
        "index.html", "admin.html", "almoxarifado.html", "atendimento.html",
        "medicacoes.html", "medico.html", "triagem.html", "tv.html"
    ];
    for (const pagina of paginas) {
        const respostaPagina = await fetch(`${baseUrl}/${pagina}`);
        assert.equal(respostaPagina.status, 200);
        assert.match(await respostaPagina.text(), /admin-shortcut\.js/);
    }
    assert.equal((await fetch(`${baseUrl}/admin-shortcut.js`)).status, 200);

    const paginaAdmin = await fetch(`${baseUrl}/admin.html`);
    assert.equal(paginaAdmin.status, 200);
    const htmlAdmin = await paginaAdmin.text();
    assert.match(htmlAdmin, /formUsuario/);
    assert.doesNotMatch(htmlAdmin, /formLoginAdmin|painelLogin/);

    const semSessao = await requisitar("/estoque");
    assert.equal(semSessao.status, 401);

    const tokenMedico = await entrar("medico-teste");
    const tokenAlmox = await entrar("almox-teste");
    const tokenTriagem = await entrar("triagem-teste");
    const tokenAdmin = await entrar("admin-teste");

    assert.equal((await requisitar("/usuarios")).status, 401);
    assert.equal((await requisitar("/usuarios", { token: tokenMedico })).status, 403);
    const listaUsuarios = await requisitar("/usuarios", { token: tokenAdmin });
    assert.equal(listaUsuarios.status, 200);
    assert.equal(listaUsuarios.data.length, 4);
    assert.equal(listaUsuarios.data.some(item =>
        Object.hasOwn(item, "senha") || Object.hasOwn(item, "senhaHash")), false);

    const cadastroUsuario = await requisitar("/usuarios", {
        method: "POST",
        token: tokenAdmin,
        body: {
            usuario: "novo-almox",
            senha: "senha-forte-de-teste",
            tipo: "almoxarifado"
        }
    });
    assert.equal(cadastroUsuario.status, 201);
    assert.equal(cadastroUsuario.data.usuario.senhaHash, undefined);
    const loginNovoUsuario = await entrar("novo-almox", "senha-forte-de-teste");
    assert.ok(loginNovoUsuario);
    assert.equal((await requisitar("/usuarios/novo-almox", {
        method: "PATCH",
        token: tokenMedico,
        body: { tipo: "medico" }
    })).status, 403);
    const atualizacaoUsuario = await requisitar("/usuarios/novo-almox", {
        method: "PATCH",
        token: tokenAdmin,
        body: { tipo: "medico", senha: "senha-atualizada-teste" }
    });
    assert.equal(atualizacaoUsuario.status, 200);
    assert.equal(atualizacaoUsuario.data.usuario.tipo, "medico");
    assert.equal((await requisitar("/login", {
        method: "POST",
        body: { usuario: "novo-almox", senha: "senha-forte-de-teste" }
    })).status, 401);
    assert.equal((await requisitar("/login", {
        method: "POST",
        body: { usuario: "novo-almox", senha: "senha-atualizada-teste" }
    })).status, 200);
    assert.equal((await requisitar("/usuarios/novo-almox", {
        method: "PATCH",
        token: tokenAdmin,
        body: { ativo: false }
    })).status, 200);
    assert.equal((await requisitar("/login", {
        method: "POST",
        body: { usuario: "novo-almox", senha: "senha-atualizada-teste" }
    })).status, 401);
    assert.equal((await requisitar("/usuarios/novo-almox", {
        method: "PATCH",
        token: tokenAdmin,
        body: { ativo: true }
    })).status, 200);
    assert.equal((await requisitar("/usuarios", {
        method: "POST",
        token: tokenAdmin,
        body: {
            usuario: "novo-almox",
            senha: "senha-forte-de-teste",
            tipo: "almoxarifado"
        }
    })).status, 409);
    assert.equal((await requisitar("/usuarios", {
        method: "POST",
        token: tokenAdmin,
        body: { usuario: "curto", senha: "123", tipo: "medico" }
    })).status, 400);
    assert.equal((await requisitar("/usuarios/admin-teste", {
        method: "PATCH",
        token: tokenAdmin,
        body: { ativo: false }
    })).status, 409);
    assert.equal((await requisitar("/usuarios/admin-teste", {
        method: "PATCH",
        token: tokenAdmin,
        body: { tipo: "medico" }
    })).status, 409);

    assert.equal((await requisitar("/estoque", { token: tokenTriagem })).status, 403);
    assert.equal((await requisitar("/medicacoes", { token: tokenAlmox })).status, 403);
    assert.equal((await requisitar("/estoque", {
        method: "POST",
        token: tokenMedico,
        body: { nome: "Proibido" }
    })).status, 403);

    const loteUm = dataFutura(120);
    const loteDois = dataFutura(60);
    const cadastro = await requisitar("/estoque", {
        method: "POST",
        token: tokenAlmox,
        body: {
            nome: "Medicamento Teste",
            categoria: "Geral",
            unidade: "comprimidos",
            quantidade: 10,
            lote: "LOTE-A",
            validade: loteUm
        }
    });
    assert.equal(cadastro.status, 201);
    const medicamentoId = cadastro.data.medicamento.id;
    assert.equal(cadastro.data.medicamento.quantidade, 10);

    const duplicado = await requisitar("/estoque", {
        method: "POST",
        token: tokenAlmox,
        body: {
            nome: "  MEDICAMENTO teste ",
            quantidade: 1,
            lote: "LOTE-X",
            validade: loteUm
        }
    });
    assert.equal(duplicado.status, 409);

    const entrada = await requisitar(`/estoque/${medicamentoId}/entradas`, {
        method: "POST",
        token: tokenAlmox,
        body: {
            quantidade: 2,
            lote: "LOTE-B",
            validade: loteDois,
            observacao: "Nota fiscal de teste"
        }
    });
    assert.equal(entrada.status, 201);
    assert.equal(entrada.data.medicamento.quantidade, 12);

    const medicamentos = await requisitar("/estoque", { token: tokenMedico });
    assert.equal(medicamentos.status, 200);
    assert.equal(medicamentos.data.length, 1);
    assert.equal(medicamentos.data[0].quantidade, 12);

    const prescricao = await requisitar("/consulta", {
        method: "POST",
        token: tokenMedico,
        body: {
            paciente: "Paciente de teste",
            medicamentoId,
            quantidade: 4,
            dosagem: "1 comprimido",
            frequencia: "a cada 8 horas",
            duracao: "5 dias"
        }
    });
    assert.equal(prescricao.status, 201);
    assert.equal(prescricao.data.consulta.estoqueInsuficiente, false);
    assert.equal(prescricao.data.consulta.responsavel, "medico-teste");
    assert.ok(prescricao.data.consulta.createdAt);

    const prescricaoSemDadosDoTratamento = await requisitar("/consulta", {
        method: "POST",
        token: tokenMedico,
        body: {
            paciente: "Paciente de teste",
            medicamentoId,
            quantidade: 1
        }
    });
    assert.equal(prescricaoSemDadosDoTratamento.status, 400);

    const prescricaoAcimaDoSaldo = await requisitar("/consulta", {
        method: "POST",
        token: tokenMedico,
        body: {
            paciente: "Paciente de teste",
            medicamentoId,
            quantidade: 13,
            dosagem: "1 comprimido",
            frequencia: "diária",
            duracao: "1 dia"
        }
    });
    assert.equal(prescricaoAcimaDoSaldo.status, 201);
    assert.equal(prescricaoAcimaDoSaldo.data.consulta.estoqueInsuficiente, true);

    const semBaixa = await requisitar("/estoque", { token: tokenMedico });
    assert.equal(semBaixa.data[0].quantidade, 12);
    const historicoPrescricoes = await requisitar("/medicacoes", { token: tokenMedico });
    assert.equal(historicoPrescricoes.data.length, 2);

    const saida = await requisitar(`/estoque/${medicamentoId}/saidas`, {
        method: "POST",
        token: tokenAlmox,
        body: {
            quantidade: 11,
            paciente: "Paciente de teste",
            prescricaoId: prescricao.data.consulta.id,
            observacao: "Dispensação de teste"
        }
    });
    assert.equal(saida.status, 201);
    assert.equal(saida.data.medicamento.quantidade, 1);

    const excesso = await requisitar(`/estoque/${medicamentoId}/saidas`, {
        method: "POST",
        token: tokenAlmox,
        body: { quantidade: 2, observacao: "Tentativa acima do saldo" }
    });
    assert.equal(excesso.status, 409);
    assert.equal((await requisitar("/estoque", { token: tokenMedico })).data[0].quantidade, 1);

    const movimentacoes = await requisitar("/movimentacoes", { token: tokenAlmox });
    assert.equal(movimentacoes.status, 200);
    assert.equal(movimentacoes.data.length, 3);
    assert.ok(movimentacoes.data.every(item => item.responsavel === "almox-teste"));
    assert.equal((await requisitar("/movimentacoes", { token: tokenMedico })).status, 403);
    const movimentoSaida = movimentacoes.data.find(item => item.tipo === "saida");
    assert.ok(movimentoSaida);
    assert.equal(movimentoSaida.prescricaoId, prescricao.data.consulta.id);
    assert.deepEqual(movimentoSaida.lotes.map(item => item.lote), ["LOTE-B", "LOTE-A"]);

    const vencido = await requisitar("/estoque", {
        method: "POST",
        token: tokenAlmox,
        body: {
            nome: "Medicamento Vencido",
            quantidade: 3,
            lote: "LOTE-VENCIDO",
            validade: new Date(Date.now() - 86400000).toISOString().slice(0, 10)
        }
    });
    assert.equal(vencido.status, 201);
    assert.equal(vencido.data.medicamento.disponivel, false);
    const prescreverVencido = await requisitar("/consulta", {
        method: "POST",
        token: tokenMedico,
        body: {
            paciente: "Paciente de teste",
            medicamentoId: vencido.data.medicamento.id,
            quantidade: 1,
            dosagem: "1 unidade",
            frequencia: "diária",
            duracao: "1 dia"
        }
    });
    assert.equal(prescreverVencido.status, 409);
});
