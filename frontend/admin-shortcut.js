
(() => {
    window.addEventListener("keydown", event => {

        const teclaA =
            event.code === "KeyA" ||
            String(event.key || "").toLowerCase() === "a";

        if (
            !event.ctrlKey ||
            !event.altKey ||
            !teclaA ||
            event.repeat
        ) {
            return;
        }

        event.preventDefault();

        // Verifica a sessão do usuário
        const token = sessionStorage.getItem("hospitalar_token");

        let usuario = {};

        try {
            usuario = JSON.parse(
                sessionStorage.getItem("hospitalar_user") || "{}"
            );
        } catch (erro) {
            console.error("Erro ao verificar usuário:", erro);
        }

        // Permite somente administrador e almoxarifado
        if (
            !token ||
            !["admin", "almoxarifado"].includes(usuario.tipo)
        ) {
            console.warn("Acesso não autorizado ao almoxarifado.");
            return;
        }

        // Abre diretamente o almoxarifado
        if (
            !window.location.pathname.toLowerCase()
                .endsWith("/almoxarifado.html")
        ) {
            window.location.assign(
                new URL("almoxarifado.html", document.baseURI).href
            );
        }
    }, true);
})();
