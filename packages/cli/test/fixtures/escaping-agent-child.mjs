// Spawned, detached, by escaping-agent.mjs - starts its own session/process group, so it
// is out of reach of a SIGTERM/SIGKILL sent to its parent's group. Waits a short beat
// (comfortably shorter than escaping-agent.mjs's own startup pause for the run after it),
// then sends one request to the base URL it was handed, and exits.
import http from "node:http";

const baseUrl = process.argv[2];

setTimeout(() => {
  const req = http.get(`${baseUrl}/late-stray-request`);
  req.on("error", () => {
    // The run that started this grandchild has long since closed its own adversary -
    // that failure to connect is the point, not a problem with this script.
  });
}, 60);
