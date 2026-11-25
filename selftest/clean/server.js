// Clean fixture: the same endpoint as selftest/vulnerable, written safely.
// The host is validated and passed to execFile as an argument, so no shell
// parses it. The self-test expects the gate to pass here.
const { execFile } = require("node:child_process");
const express = require("express");

const app = express();
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

app.get("/ping", (req, res) => {
  const host = String(req.query.host || "");
  if (!HOST.test(host)) {
    res.status(400).send("invalid host");
    return;
  }
  execFile("ping", ["-c", "1", host], { timeout: 5000 }, (err, stdout) => {
    res.type("text/plain").send(err ? "ping failed" : stdout);
  });
});

app.listen(8080);
