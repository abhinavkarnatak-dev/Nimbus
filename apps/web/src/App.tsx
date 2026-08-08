import { CONTRACTS_VERSION } from '@nimbus/contracts';

export function App(): React.JSX.Element {
  return (
    <main>
      <h1>Nimbus</h1>
      <p>Workspace foundation is in place. Contracts version {CONTRACTS_VERSION}.</p>
    </main>
  );
}
