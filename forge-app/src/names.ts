/**
 * Anonymous display names such as "amber-falcon-quiet-river": four random words from
 * a list of about 250, for tenants that don't want to reveal their site to partners.
 */
const WORDS = (
  "amber anchor apple arch arrow aspen atlas autumn badge bamboo banner basin beacon berry birch blaze " +
  "bloom bolt bramble breeze brick bridge brook bronze cabin cactus canyon cape cedar chalk cherry cinder " +
  "citrus clay cliff clover coast cobalt comet copper coral cosmic cotton crane crater creek crest crown " +
  "crystal current cypress dawn delta desert dew dune dusk eagle echo ember emerald fable falcon fern " +
  "field fig fjord flame flint flora fog forest fossil fox frost galaxy garnet gate glacier glade glow " +
  "granite grove gull harbor hawk hazel heath heron hill hollow honey horizon iris island ivory ivy jade " +
  "jasper juniper kelp kite lagoon lake lantern lark laurel lava leaf lemon lilac lily linen lotus lunar " +
  "lynx magnet maple marble marsh meadow mesa mint mist moss moth mountain nectar nebula north oak oasis " +
  "ocean olive onyx opal orbit orchid otter owl palm pebble pepper pine planet plum polar pond poppy prairie " +
  "prism quartz quail quiet rain raven reed reef ridge river robin rock rose ruby sage salt sand sapphire " +
  "shadow shell shore silk silver sky slate snow solar sparrow spring spruce star stone storm stream summit " +
  "sun swan teal thistle thorn thunder tide timber topaz tulip tundra valley velvet violet wave willow wind " +
  "winter wolf wren yarrow zenith zephyr acorn alder basil bay beryl brass canary cloud dove elm " +
  "finch garden gem hearth indigo kestrel lime lumen mango merlin nova peak pearl petal pilot rapid " +
  "rowan saffron sierra spark tango tiger ultra vale vapor vista walnut wisp yew zinc aurora cove jet"
)
  .split(" ");
const UNIQUE = [...new Set(WORDS)];

export function randomName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => UNIQUE[b % UNIQUE.length]).join("-");
}
