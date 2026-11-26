(() => {
    const paginaAdmin = new URL("admin.html", document.baseURI);

    window.addEventListener("keydown", event => {
        const teclaA = event.code === "KeyA" ||
            String(event.key || "").toLowerCase() === "a";

        if (!event.ctrlKey || !event.altKey || !teclaA || event.repeat) {
            return;
        }

        event.preventDefault();

        if (window.location.pathname.toLowerCase() !==
            paginaAdmin.pathname.toLowerCase()) {
            window.location.assign(paginaAdmin.href);
        }
    }, true);
})();
