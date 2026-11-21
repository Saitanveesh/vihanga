import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ControlPanel from "./ControlPanel";
import type { OperatorCatalog } from "./api";

afterEach(cleanup);

function overview(bench: boolean): OperatorCatalog {
  return {
    vehicle_id: "AH-HW-001",
    physical_flight_control_enabled: false,
    cloud_command_dispatch_enabled: false,
    read_only_bench_enabled: bench,
    operations: [
      {code:"ARM",label:"Arm motors",group:"FLIGHT",risk:"CRITICAL",
        requirement:"PILOT_LEASE",enabled:false,status:"LOCKED",
        reason:"CONTROL_AUTHORITY_NOT_IMPLEMENTED",bench_query:null},
      {code:"LAND",label:"Land",group:"FLIGHT",risk:"CRITICAL",
        requirement:"FLIGHT_CLEARANCE",enabled:false,status:"LOCKED",
        reason:"CONTROL_AUTHORITY_NOT_IMPLEMENTED",bench_query:null},
      {code:"FC_VERSION",label:"Flight controller version",group:"DIAGNOSTICS",risk:"READ",
        requirement:"BENCH_READ",enabled:bench,status:bench?"READY":"LOCKED",
        reason:bench?"AVAILABLE_LOCAL_BENCH_READ":"BENCH_OPT_IN_REQUIRED",bench_query:"FC_VERSION"},
      {code:"PARAM_READ",label:"Read parameter",group:"PARAMETERS",risk:"READ",
        requirement:"BENCH_READ",enabled:bench,status:bench?"READY":"LOCKED",
        reason:bench?"AVAILABLE_LOCAL_BENCH_READ":"BENCH_OPT_IN_REQUIRED",bench_query:"PARAMETER_READ"},
    ]
  };
}

describe("flight operation controls", () => {
  it("cannot fire ARM, LAND or mode control without real authority", () => {
    const onBenchQuery=vi.fn();
    render(<ControlPanel aircraftId="AH-HW-001" catalog={overview(true)}
      telemetry={undefined} readback={null} busy={false}
      onClose={vi.fn()} onBenchQuery={onBenchQuery}
      onRefreshReadback={vi.fn()}/>);
    expect((screen.getByRole("button",{name:/Arm motors/}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button",{name:/Land/}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button",{name:/Arm motors/}));
    expect(onBenchQuery).not.toHaveBeenCalled();
    expect(screen.queryByText("Flight command path locked")).toBeNull();
  });

  it("only a proven local bench read enables an information request", () => {
    const onBenchQuery=vi.fn();
    const view=render(<ControlPanel aircraftId="AH-HW-001" catalog={overview(false)}
      telemetry={undefined} readback={null} busy={false}
      onClose={vi.fn()} onBenchQuery={onBenchQuery}
      onRefreshReadback={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"Diagnostics"}));
    let request=screen.getByRole("button",{name:/Flight controller version/}) as HTMLButtonElement;
    expect(request.disabled).toBe(true);
    view.rerender(<ControlPanel aircraftId="AH-HW-001" catalog={overview(true)}
      telemetry={undefined} readback={null} busy={false}
      onClose={vi.fn()} onBenchQuery={onBenchQuery}
      onRefreshReadback={vi.fn()}/>);
    request=screen.getByRole("button",{name:/Flight controller version/}) as HTMLButtonElement;
    expect(request.disabled).toBe(false);
    fireEvent.click(request);
    expect(onBenchQuery).toHaveBeenCalledWith("FC_VERSION",undefined);
  });
});
