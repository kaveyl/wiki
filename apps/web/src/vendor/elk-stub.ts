// Stands in for elkjs (Eclipse Public License 2.0, not compatible with the AGPL of Kaveyl Wiki – owner 2026-10-22,
// AD-064): Mermaid's optional „elk“ layout is left out of the build (vite.config.ts, resolve.alias). Diagrams that ask
// for it get an error from Mermaid; every other layout works as before.
export default class ELK {
  layout(): Promise<never> {
    return Promise.reject(new Error('The “elk” diagram layout is not included in Kaveyl Wiki – use the default layout.'));
  }
}
