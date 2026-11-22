import { expect, it } from "vitest";
import { missionPlannerFile } from "./missionFile";
it("preserves route order and separates absolute home altitude from relative waypoint altitude", () => {
  const route = [1, 2].map(n => ({latitude: 12 + n, longitude: 77, altitude_m: 35}));
  const rows = missionPlannerFile({latitude:12, longitude:77, altitude_msl_m:900}, route).trim().split("\r\n");
  expect(rows[0]).toBe("QGC WPL 110");
  expect(rows[1].split("\t").slice(0,4)).toEqual(["0","1","0","16"]);
  expect(rows[1].split("\t")[10]).toBe("900.000");
  expect(rows.slice(2).map(row => row.split("\t")[8])).toEqual(["13.0000000","14.0000000"]);
  expect(rows[2].split("\t")[2]).toBe("3");
});