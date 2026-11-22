import { Component, Suspense, type ReactNode } from "react";

type Props = { name: string; floating?: boolean; children: ReactNode };

export default class PanelLoader extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    const { name, floating, children } = this.props;
    const className = floating ? "station-map-error" : "station-panel-loading";
    if (this.state.failed) {
      return <p className={className} role="alert">Unable to load {name}. Refresh the console to retry.</p>;
    }
    return <Suspense fallback={<p className={className} role="status">Loading {name}</p>}>{children}</Suspense>;
  }
}
