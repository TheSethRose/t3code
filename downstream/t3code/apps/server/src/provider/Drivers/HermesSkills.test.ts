import { expect, it } from "vite-plus/test";

import { parseHermesSkillsList } from "./HermesSkills.ts";

it("parses the enabled skill names resolved by a Hermes profile", () => {
  const output = `
┏━━━━━━━━━━━┳━━━━━━━━┓
┃ Name      ┃ Status ┃
┡━━━━━━━━━━━╇━━━━━━━━┩
│ alpha     │ enabled│
│ profile-x │ enabled│
└───────────┴────────┘`;

  expect(parseHermesSkillsList(output, "work")).toEqual([
    {
      name: "alpha",
      model: "hermes/work",
      path: "hermes://work/skills/alpha",
      scope: "Hermes profile: work",
      enabled: true,
    },
    {
      name: "profile-x",
      model: "hermes/work",
      path: "hermes://work/skills/profile-x",
      scope: "Hermes profile: work",
      enabled: true,
    },
  ]);
});
