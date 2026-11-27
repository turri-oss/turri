import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { BEDROCK_DEFAULT, BEDROCK_IN_REGION, VENDORS, bedrockDefaultModels, bedrockMakers, bedrockModels, bedrockModelsIn, bedrockPlaceOf, hasBedrockPreset, initConfig, makerLabel, piModelCatalogue, type BedrockMaker, type ModelCatalogue, type ModelChoice, type Vendor } from "@turri-dev/core/config";
import { bedrockMakerOf, bedrockRegionOf, priced, vendorOf, type Asked } from "@turri-dev/core/commands";
import { brand } from "./brand.ts";

const USAGE = [
  "usage: turri init-config [--vendor anthropic|openai|google|amazon-bedrock|other] [--maker <maker>] [--region <geography>]",
  "                         [--harness-model <spec> --coding-model <spec> [--judge-model <spec>]] [--force] [folder]",
  "",
  "Write a quick start config.turri.yaml in the folder, the current one by default: the model you talk to and the one that",
  "writes the code, from the vendor you use. Asked when --vendor is not given and this is a terminal; otherwise other -",
  "a mix of Anthropic and Google, the starting point for any provider pi supports. On amazon-bedrock, --maker and",
  "--region say whose models and where - any maker and geography pi's catalogue has there (anthropic, openai, xai, meta,",
  "...; global, us, eu, jp, au, apac, in, ca, us-gov, or in-region) - asked when not given, then which two, turri's own",
  "pair or the catalogue's offered first. --harness-model and --coding-model name the two instead, as provider/model-id",
  "without a thinking level - amazon-bedrock/global.xai.grok-4.7 - any pi's catalogue has; --judge-model the strong one",
  "the judging examples name, the harness model unless given. The vendor, maker and region are read from them.",
  "A config.turri.yaml already there keeps everything but its two models; --force writes the whole of it again. A new",
  "one takes from a config.yaml beside it - another tool's, say - the keys turri reads too, its testing scripts say, and leaves",
  "config.yaml as it is.",
].join("\n");

/** Ask until the answer is one `read` takes. */
async function askUntil<T>(rl: ReturnType<typeof createInterface>, prompt: string, read: (answer: string) => T | undefined, again: string): Promise<T> {
  for (;;) {
    const chosen = read(await rl.question(prompt));
    if (chosen !== undefined) return chosen;
    console.log(again);
  }
}

/**
 * Ask which vendor's models to use - a number or a name - and, for Amazon Bedrock, whose and where, from pi's catalogue,
 * then which two: the pair offered taken with Enter, or chosen from the maker's models there. What is given is not asked.
 */
async function askVendor(given: { vendor?: Vendor; maker?: BedrockMaker; region?: string }, catalogue: () => Promise<ModelCatalogue>): Promise<Asked> {
  const names = Object.keys(VENDORS) as Vendor[];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /** A question: a blank line before it, its choices numbered, each with what it is. */
  const ask = (question: string, choices: Array<[string, string]>) => {
    console.log(`\n${brand.bold(brand.accent(question))}`);
    const width = Math.max(...choices.map(([label]) => label.length)) + 3;
    choices.forEach(([label, what], index) => console.log(`  ${brand.accent(`${String(index + 1).padStart(String(choices.length).length)}`)}  ${label.padEnd(width)}${brand.muted(what)}`));
  };
  const choose = (count: number) => `\n${brand.muted(`Choose 1-${count}:`)} `;
  try {
    let vendor = given.vendor;
    if (vendor === undefined) {
      ask(
        "Which vendor's models do you use?",
        names.map((name) => {
          const { label, harness, coding } = VENDORS[name];
          const what =
            name === "amazon-bedrock"
              ? "Anthropic's, OpenAI's, xAI's, Meta's... models on AWS"
              : name === "claude-code"
                ? `your Claude Pro or Max, through Claude Code - ${harness.split("/")[1]} to talk to, ${coding.split("/")[1]} to code`
              : `${name === "other" ? "a mix - " : ""}${harness.split("/")[1]} to talk to, ${coding.split("/")[1]} to code`;
          return [label, what];
        }),
      );
      vendor = await askUntil(rl, choose(names.length), vendorOf, `Type a number from 1 to ${names.length}, or a vendor's name.`);
    }
    if (vendor !== "amazon-bedrock") return { vendor };
    const known = await catalogue();
    const makers = bedrockMakers(known);
    let maker = given.maker;
    if (maker === undefined) {
      ask(
        "Whose models, on Amazon Bedrock?",
        makers.map((offer) => {
          const own = offer.maker === "anthropic" || offer.maker === "openai" ? bedrockModels({ maker: offer.maker, region: "global" }) : undefined;
          return [offer.label, own !== undefined ? `${own.harness.split(".").slice(2).join(".")} to talk to, ${own.coding.split(".").slice(2).join(".")} to code` : offer.regions.join(", ")];
        }),
      );
      maker = await askUntil(rl, choose(makers.length), (answer) => bedrockMakerOf(answer, known), `Type a number from 1 to ${makers.length}, or a maker's name.`);
    }
    const regions = makers.find((offer) => offer.maker === maker)?.regions ?? [];
    let region = given.region !== undefined ? bedrockRegionOf(maker, given.region, known) : undefined;
    if (region === undefined) {
      ask(
        "Which region?",
        regions.map((entry) => [entry, entry === "global" ? "wherever Bedrock has room" : entry === BEDROCK_IN_REGION ? "the AWS region it is called in" : ""]),
      );
      region = await askUntil(rl, choose(regions.length), (answer) => bedrockRegionOf(maker!, answer, known), `Type a number from 1 to ${regions.length}, or one of ${regions.join(", ")}.`);
    }
    const bedrock = { maker, region };
    const offered = bedrockDefaultModels(known, bedrock);
    const models = bedrockModelsIn(known, bedrock);
    if (offered === undefined || models.length < 2) return { vendor, bedrock };
    const bare = (spec: string) => spec.replace(/^amazon-bedrock\//, "");
    console.log(`\n${brand.bold(brand.accent("Which models?"))}`);
    console.log(`  ${bare(offered.harness)} ${brand.muted("to talk to,")} ${bare(offered.coding)} ${brand.muted("to code")}`);
    const keep = (await rl.question(`\n${brand.muted("Enter takes them; c chooses others:")} `)).trim().toLowerCase();
    if (keep !== "c") return { vendor, bedrock };
    ask("The model you talk to - it writes the specs and plans the work", models.map((model) => [model.id, priced(model)]));
    const pick = (fallback: string) => (answer: string) => {
      const typed = answer.trim();
      if (typed === "") return fallback;
      const model = (/^\d+$/.test(typed) ? models[Number(typed) - 1] : undefined) ?? models.find((entry) => entry.id === typed);
      return model !== undefined ? `amazon-bedrock/${model.id}` : undefined;
    };
    const atOf = (spec: string) => models.findIndex((model) => `amazon-bedrock/${model.id}` === spec) + 1;
    const again = `Type a number from 1 to ${models.length}, or Enter for the one offered.`;
    const harness = await askUntil(rl, `\n${brand.muted(`Choose 1-${models.length}, Enter for ${atOf(offered.harness)}:`)} `, pick(offered.harness), again);
    ask("The model that writes the code - a smaller, cheaper one", models.map((model) => [model.id, priced(model)]));
    const coding = await askUntil(rl, `\n${brand.muted(`Choose 1-${models.length}, Enter for ${atOf(offered.coding)}:`)} `, pick(offered.coding), again);
    return { vendor, bedrock, models: { harness, coding, ...(harness === offered.harness ? { strong: offered.strong } : {}) } };
  } finally {
    rl.close();
  }
}

/** A flag's value: `--name value` or `--name=value`, and where the value was, to leave it out of the folder. */
function flagOf(args: string[], name: string): { value?: string; at: number[] } {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return { at: [] };
  return args[index]!.includes("=") ? { value: args[index]!.slice(args[index]!.indexOf("=") + 1), at: [index] } : { value: args[index + 1], at: [index, index + 1] };
}

/** `turri init-config [--vendor <vendor>] [--maker <maker>] [--region <geography>] [--harness-model <spec> --coding-model <spec>] [--force] [folder]`. */
export async function main(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const flags = {
    vendor: flagOf(args, "vendor"),
    maker: flagOf(args, "maker"),
    region: flagOf(args, "region"),
    harness: flagOf(args, "harness-model"),
    coding: flagOf(args, "coding-model"),
    judge: flagOf(args, "judge-model"),
  };
  const taken = new Set(Object.values(flags).flatMap((flag) => flag.at));
  const rest = args.filter((arg, index) => !arg.startsWith("-") && !taken.has(index));
  const folder = rest[0] ?? process.cwd();
  if (!existsSync(folder)) {
    console.error(`${folder} does not exist.`);
    return 1;
  }
  let vendor: Vendor | undefined;
  if (flags.vendor.value !== undefined) {
    vendor = vendorOf(flags.vendor.value);
    if (vendor === undefined) {
      console.error(`Not a vendor: ${flags.vendor.value}. One of ${Object.keys(VENDORS).join(", ")}.\n\n${USAGE}`);
      return 1;
    }
  }
  // pi's catalogue, read once and only when it is needed: models named, or a maker or region beyond turri's own pair.
  let read: ModelCatalogue | undefined;
  const catalogue = async () => (read ??= await piModelCatalogue());
  const [harness, coding, judge] = [flags.harness.value, flags.coding.value, flags.judge.value];
  if ((harness === undefined) !== (coding === undefined) || (judge !== undefined && harness === undefined)) {
    console.error(`Name both models - --harness-model and --coding-model - or neither.\n\n${USAGE}`);
    return 1;
  }
  const named: ModelChoice | undefined = harness !== undefined && coding !== undefined ? { harness, coding, ...(judge !== undefined ? { strong: judge } : {}) } : undefined;
  let maker: BedrockMaker | undefined;
  if (flags.maker.value !== undefined) {
    const typed = flags.maker.value.trim().toLowerCase();
    maker = bedrockMakerOf(typed, ["anthropic", "openai"].includes(typed) ? undefined : await catalogue());
    if (maker === undefined) {
      console.error(`Not a maker pi's catalogue has on Amazon Bedrock: ${flags.maker.value}. One of ${bedrockMakers(await catalogue()).map((offer) => offer.maker).join(", ")}.\n\n${USAGE}`);
      return 1;
    }
  }
  const region = flags.region.value?.trim().toLowerCase();
  if (region !== undefined && named === undefined) {
    const of = maker ?? BEDROCK_DEFAULT.maker;
    if (!hasBedrockPreset({ maker: of, region }) && bedrockRegionOf(of, region, await catalogue()) === undefined) {
      const regions = bedrockMakers(await catalogue()).find((offer) => offer.maker === of)?.regions ?? [];
      console.error(`Not a region ${makerLabel(of)}'s models run in on Bedrock: ${region}. One of ${regions.join(", ")}.`);
      return 1;
    }
  }
  const force = args.includes("--force");
  const asking = process.stdin.isTTY && process.stdout.isTTY && named === undefined;
  let chosen: Asked;
  try {
    chosen = await chooseVendor();
  } catch (error) {
    // Ctrl+C or Ctrl+D at a question: stopped, nothing written - not a crash.
    if ((error as { code?: string }).code === "ABORT_ERR") {
      console.log(`\n${brand.muted("Stopped - nothing written.")}`);
      return 1;
    }
    throw error;
  }
  async function chooseVendor(): Promise<Asked> {
    if (named !== undefined) {
      return {
        ...(vendor !== undefined ? { vendor } : {}),
        ...(maker !== undefined || region !== undefined ? { bedrock: { ...(maker !== undefined ? { maker } : {}), region: region ?? bedrockPlaceOf(named.harness).geography } } : {}),
        models: named,
      };
    }
    return asking && (vendor === undefined || (vendor === "amazon-bedrock" && (maker === undefined || region === undefined)))
      ? await askVendor({ ...(vendor !== undefined ? { vendor } : {}), ...(maker !== undefined ? { maker } : {}), ...(region !== undefined ? { region } : {}) }, catalogue)
      : {
          vendor: vendor ?? "other",
          ...(vendor === "amazon-bedrock" ? { bedrock: { maker: maker ?? BEDROCK_DEFAULT.maker, region: region ?? BEDROCK_DEFAULT.region } } : {}),
        };
  }
  const result = await initConfig(folder, {
    paint: brand,
    force,
    ...(chosen.vendor !== undefined ? { vendor: chosen.vendor } : {}),
    ...(chosen.bedrock !== undefined ? { bedrock: chosen.bedrock } : {}),
    ...(chosen.models !== undefined ? { models: chosen.models } : {}),
    ...(read !== undefined ? { catalogue: read } : {}),
  });
  (result.written ? console.log : console.error)(result.message);
  return result.written ? 0 : 1;
}
