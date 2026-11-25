// DELIBERATELY VULNERABLE FIXTURE: do not copy this code.
// The self-test expects the Darknode scanner to report a critical command
// injection here (the "host" query parameter flows into child_process.exec)
// and the gate to fail. The root .darknodeignore keeps it out of whole-repo scans.
const { exec } = require("node:child_process");
const express = require("express");

const app = express();

app.get("/ping", (req, res) => {
  const host = req.query.host;
  exec("ping -c 1 " + host, (err, stdout) => {
    res.type("text/plain").send(err ? "ping failed" : stdout);
  });
});

app.listen(8080);
