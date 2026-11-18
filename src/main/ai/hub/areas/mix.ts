/**
 * Puts the methods of the hub's parts on the hub's class.
 *
 * The hub is one object. Its methods are kept in several files (one per area, in this folder), each
 * as a class that is never made into an object of its own: its methods are copied onto HubService
 * here, when HubService.ts is loaded, and run as the hub's (`this` is the hub).
 *
 * A method name that is on the class already is refused: two parts must not both define it.
 */
export function mixParts(target: { prototype: object }, parts: ReadonlyArray<{ name: string; prototype: object }>): void {
  for (const part of parts) {
    for (const name of Object.getOwnPropertyNames(part.prototype)) {
      if (name === "constructor") continue;
      if (Object.prototype.hasOwnProperty.call(target.prototype, name)) throw new Error(`${part.name}.${name} is already a method of the hub`);
      Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name)!);
    }
  }
}
