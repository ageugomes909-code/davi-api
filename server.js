const express = require("express");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Página inicial simples para confirmar que a API está online.
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Davi API</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b1020; color:#edf2ff; font:16px system-ui,sans-serif; }
    main { width:min(90%,520px); padding:28px; border:1px solid #26314d; border-radius:18px; background:#121a2d; box-sizing:border-box; }
    h1 { margin-top:0; } p { color:#b8c4df; }
    code { color:#8be9fd; }
    .ok { color:#7ee787; font-weight:700; }
  </style>
</head>
<body><main>
  <h1>Davi API</h1>
  <p class="ok">● Servidor online</p>
  <p>O servidor Node.js está funcionando.</p>
  <p>Verificação de estado: <code>/health</code></p>
  <p>Informações da API: <code>/api</code></p>
</main></body></html>`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "davi-api" });
});

app.get("/api", (req, res) => {
  res.json({
    name: "davi-api",
    status: "online",
    message: "API funcionando",
    endpoints: ["/", "/health", "/api"]
  });
});

// O Northflank fornece a porta por variável de ambiente.
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Davi API rodando na porta ${PORT}`);
});
