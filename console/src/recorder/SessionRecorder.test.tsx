import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SessionRecorder from "./SessionRecorder";
import { appendSample, beginRun, listRuns, loadSamples, sampleAt, type Sample } from "./archive";

vi.mock("./archive", async original => ({
  ...await original<typeof import("./archive")>(),
  appendSample: vi.fn(), beginRun: vi.fn(), listRuns: vi.fn(), loadSamples: vi.fn()
}));
afterEach(cleanup);
const sample: Sample = { run: "test", receiver: "PRIMARY/cloud", at: 2000, frames: 5,
  position: { latitude: 12, longitude: 77 },
  values: { voltage_v: 11.7, climb_mps: 0, groundspeed_mps: 0, relative_alt_m: 0 } };

it("leaves gaps empty during replay", () => {
  const later = { ...sample, at: 9000 };
  expect(sampleAt([sample, later], 1500)).toBeNull();
  expect(sampleAt([sample, later], 2000)).toBe(sample);
  expect(sampleAt([sample, later], 6000)).toBeNull();
  expect(sampleAt([sample, later], 9000)).toBe(later);
});

it("writes new samples while the recorder is hidden and reopens the saved session", async () => {
  const run = { id: "test", scope: "A", started: 1500 };
  vi.mocked(listRuns).mockResolvedValue([run]);
  vi.mocked(beginRun).mockResolvedValue(run);
  vi.mocked(appendSample).mockResolvedValue();
  vi.mocked(loadSamples).mockResolvedValue([sample]);
  const props = { scope: "A", aircraft: "A", receiver: sample.receiver, onReview: vi.fn() };
  const view = render(<SessionRecorder {...props} visible/>);
  fireEvent.click(screen.getByRole("button", { name: "Record session" }));
  await screen.findByRole("button", { name: "Stop & review" });
  view.rerender(<SessionRecorder {...props} visible={false} latest={sample}/>);
  await waitFor(() => expect(appendSample).toHaveBeenCalledWith(sample));
  view.rerender(<SessionRecorder {...props} visible latest={sample} receiver="BACKUP/USB"/>);
  expect(appendSample).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Stop & review" }));
  await screen.findByRole("slider", { name: "Recording time" });
  expect(props.onReview).toHaveBeenCalledWith(sample);
  view.unmount();
  render(<SessionRecorder {...props} visible/>);
  await screen.findByRole("option", { name: new Date(run.started).toLocaleString() });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "test" } });
  await screen.findByRole("slider", { name: "Recording time" });
  expect(loadSamples).toHaveBeenCalledTimes(2);
});
