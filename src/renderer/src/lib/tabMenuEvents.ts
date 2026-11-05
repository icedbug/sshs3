/** Window event App dispatches for the "Tab Actions" shortcut; the tab bar opens the menu of that tab. */
export const OPEN_TAB_MENU_EVENT = 'sshs3:open-tab-menu';

export function openTabMenuFor(tabId: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_TAB_MENU_EVENT, { detail: tabId }));
}
