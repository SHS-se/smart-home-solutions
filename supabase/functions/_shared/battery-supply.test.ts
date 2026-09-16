import { assertEquals } from "@std/assert";
import { proportionalSupply } from "./battery-supply.ts";

Deno.test("decimal solar surplus cannot create a negative supply bound", () => {
  for (const house of [1000.067, 1100.123456, 1279.009, 3340.99]) {
    for (const eligible of [house, house / 3]) {
      for (const pv of [house, house + 500]) {
        assertEquals(
          proportionalSupply(house, pv, eligible).houseSupplyBoundW,
          0,
        );
      }
    }
  }
});
