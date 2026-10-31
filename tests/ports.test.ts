import { expect, it, vi } from "vitest";
import { planPorts } from "../scripts/ports.mjs";

it("keeps the three default ports when they are available", async () => {
  expect(await planPorts({}, false, async () => true)).toEqual({
    frontend: "3100", api: "3080", workstation: "3101", notices: [],
  });
});

it("moves a busy frontend past the reserved backend port and updates the chosen UI port", async () => {
  const ports = await planPorts({}, false, async (port) => port !== 3100);
  expect(ports).toMatchObject({ frontend: "3102", api: "3080", workstation: "3101" });
  expect(ports.notices).toEqual(["frontend port 3100 is unavailable; using 3102."]);
});

it("assigns distinct ports when every default is busy", async () => {
  const ports = await planPorts({}, false, async (port) => ![3080, 3100, 3101].includes(port));
  expect(ports).toMatchObject({ frontend: "3102", api: "3081", workstation: "3103" });
});

it("honors an explicit frontend port before moving the default workstation", async () => {
  expect(await planPorts({ PORT: "3101" }, false, async () => true)).toMatchObject({
    frontend: "3101", workstation: "3102",
  });
});

it("rejects conflicting explicit ports before checking other services", async () => {
  const available = vi.fn(async () => true);
  await expect(planPorts({ PORT: "3100", WORKSTATION_PORT: "3100" }, false, available)).rejects.toThrow("workstation port 3100");
  expect(available).toHaveBeenCalledTimes(1);
});

it("does not silently change a configured origin or a busy explicitly configured port", async () => {
  for (const env of [{ PORT: "3200" }, { APP_ORIGIN: "http://127.0.0.1:3100" }]) {
    await expect(planPorts(env, false, async () => false)).rejects.toThrow("already in use");
  }
});

it("keeps production ports fixed and uses the actual API port as the public port", async () => {
  expect(await planPorts({ V0_API_PORT: "8080" }, true, async () => true)).toMatchObject({
    frontend: "8080", api: "8080", workstation: "3101",
  });
  await expect(planPorts({}, true, async () => false)).rejects.toThrow("api port 3100");
});

it("reports invalid ports and listener permission failures", async () => {
  for (const PORT of ["0", "65536", "invalid", "1.5"]) {
    await expect(planPorts({ PORT }, false, async () => true)).rejects.toThrow("Invalid frontend port");
  }
  await expect(planPorts({}, false, async () => { throw new Error("EPERM"); })).rejects.toThrow("EPERM");
});
