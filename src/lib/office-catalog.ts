/** Public metadata only; purchased GLBs and previews stay in the private runtime bundle. */
export type OfficeAssetDefinition = {id:string;name:string;category:'desks'|'seating'|'tables'|'storage'|'plants'|'lighting'|'architecture';width:number;depth:number;height:number;resize:'uniform'|'footprint';collidable?:boolean};
export const OFFICE_CATEGORIES = [{id:'desks',name:'Desks'},{id:'seating',name:'Seating'},{id:'tables',name:'Tables'},{id:'storage',name:'Storage'},{id:'plants',name:'Plants'},{id:'lighting',name:'Lighting'},{id:'architecture',name:'Partitions & floors'}] as const;
export const OFFICE_CATALOG:readonly OfficeAssetDefinition[] = [
  {
    "id": "office-desk-001",
    "name": "Compact task desk",
    "category": "desks",
    "width": 1.584749,
    "depth": 0.662975,
    "height": 0.72934,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-003",
    "name": "White pedestal desk",
    "category": "desks",
    "width": 1.283176,
    "depth": 0.627003,
    "height": 0.738887,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-007",
    "name": "Studio desk with shelving",
    "category": "desks",
    "width": 1.504793,
    "depth": 0.639802,
    "height": 1.006163,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-010",
    "name": "Walnut writing desk",
    "category": "desks",
    "width": 1.584749,
    "depth": 0.662966,
    "height": 0.723243,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-011",
    "name": "Walnut computer workstation",
    "category": "desks",
    "width": 1.287222,
    "depth": 0.71614,
    "height": 1.079185,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-014",
    "name": "Double-pedestal desk",
    "category": "desks",
    "width": 2.056178,
    "depth": 0.71955,
    "height": 0.757472,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-015",
    "name": "Sand computer workstation",
    "category": "desks",
    "width": 1.283176,
    "depth": 0.627003,
    "height": 1.130523,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-016",
    "name": "Powder blue desk",
    "category": "desks",
    "width": 1.400044,
    "depth": 0.627005,
    "height": 0.660048,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-017",
    "name": "Oak frame desk",
    "category": "desks",
    "width": 1.287424,
    "depth": 0.627003,
    "height": 0.773814,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-024",
    "name": "Trestle desk",
    "category": "desks",
    "width": 1.40543,
    "depth": 0.67562,
    "height": 0.851186,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-029",
    "name": "Slim writing desk",
    "category": "desks",
    "width": 1.147061,
    "depth": 0.370986,
    "height": 0.645312,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-030",
    "name": "Graphite executive desk",
    "category": "desks",
    "width": 1.502261,
    "depth": 0.610045,
    "height": 0.750084,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-031",
    "name": "Walnut corner desk",
    "category": "desks",
    "width": 1.918442,
    "depth": 1.417266,
    "height": 0.773815,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-033",
    "name": "Graphite corner desk",
    "category": "desks",
    "width": 2.170049,
    "depth": 2.027754,
    "height": 0.732584,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-035",
    "name": "White frame desk",
    "category": "desks",
    "width": 1.287422,
    "depth": 0.627002,
    "height": 0.773814,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-desk-040",
    "name": "White computer workstation",
    "category": "desks",
    "width": 1.283176,
    "depth": 0.627003,
    "height": 1.130523,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-001",
    "name": "Graphite task chair",
    "category": "seating",
    "width": 0.654941,
    "depth": 0.688916,
    "height": 1.171887,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-006",
    "name": "Grey visitor chair",
    "category": "seating",
    "width": 0.602729,
    "depth": 0.690756,
    "height": 1.048319,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-007",
    "name": "Blush visitor chair",
    "category": "seating",
    "width": 0.602729,
    "depth": 0.559437,
    "height": 0.874575,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-009",
    "name": "Sand task chair",
    "category": "seating",
    "width": 0.610344,
    "depth": 0.655167,
    "height": 0.999766,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-012",
    "name": "Mesh task chair",
    "category": "seating",
    "width": 0.65397,
    "depth": 0.674788,
    "height": 1.067452,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-014",
    "name": "Slate task chair",
    "category": "seating",
    "width": 0.610342,
    "depth": 0.72013,
    "height": 1.135195,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-017",
    "name": "Executive task chair",
    "category": "seating",
    "width": 0.654939,
    "depth": 0.688916,
    "height": 1.158469,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-chair-022",
    "name": "White beanbag",
    "category": "seating",
    "width": 0.878677,
    "depth": 0.838529,
    "height": 0.761608,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-armchair-001",
    "name": "Sand lounge chair",
    "category": "seating",
    "width": 0.91666,
    "depth": 1.003147,
    "height": 0.785866,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-armchair-002",
    "name": "Graphite lounge chair",
    "category": "seating",
    "width": 1.097544,
    "depth": 1.06999,
    "height": 0.741016,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-armchair-003",
    "name": "White frame armchair",
    "category": "seating",
    "width": 0.768774,
    "depth": 0.828822,
    "height": 0.68536,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-armchair-006",
    "name": "Wingback chair",
    "category": "seating",
    "width": 0.82885,
    "depth": 0.880471,
    "height": 0.906147,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-armchair-008",
    "name": "Cloud blue armchair",
    "category": "seating",
    "width": 0.857883,
    "depth": 0.865916,
    "height": 0.68681,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-armchair-011",
    "name": "Walnut lounge chair",
    "category": "seating",
    "width": 1.007998,
    "depth": 0.802491,
    "height": 0.835677,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-001",
    "name": "Cloud blue three-seat sofa",
    "category": "seating",
    "width": 2.049165,
    "depth": 0.868053,
    "height": 0.688505,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-004",
    "name": "Sand three-seat sofa",
    "category": "seating",
    "width": 2.234744,
    "depth": 1.069992,
    "height": 0.59588,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-005",
    "name": "Graphite two-seat sofa",
    "category": "seating",
    "width": 2.050205,
    "depth": 1.009338,
    "height": 0.730855,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-011",
    "name": "Cloud blue loveseat",
    "category": "seating",
    "width": 1.448562,
    "depth": 0.865917,
    "height": 0.68681,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-013",
    "name": "Walnut frame sofa",
    "category": "seating",
    "width": 1.839956,
    "depth": 0.927554,
    "height": 0.68143,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-019",
    "name": "Sand corner sofa",
    "category": "seating",
    "width": 2.932185,
    "depth": 3.209363,
    "height": 0.581229,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-022",
    "name": "Slate lounge sofa",
    "category": "seating",
    "width": 1.968484,
    "depth": 0.949119,
    "height": 0.778951,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-sofa-032",
    "name": "White lounge sofa",
    "category": "seating",
    "width": 2.050205,
    "depth": 1.009338,
    "height": 0.730855,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-003",
    "name": "Oak side table",
    "category": "tables",
    "width": 0.548525,
    "depth": 0.535697,
    "height": 0.482847,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-006",
    "name": "Glass coffee table",
    "category": "tables",
    "width": 0.592776,
    "depth": 0.935403,
    "height": 0.312705,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-007",
    "name": "White oval coffee table",
    "category": "tables",
    "width": 1.317895,
    "depth": 0.615558,
    "height": 0.390547,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-009",
    "name": "Round table with books",
    "category": "tables",
    "width": 0.486145,
    "depth": 0.486145,
    "height": 0.56431,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-014",
    "name": "Round walnut coffee table",
    "category": "tables",
    "width": 0.901211,
    "depth": 0.901208,
    "height": 0.314363,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-016",
    "name": "Graphite coffee table",
    "category": "tables",
    "width": 1.531484,
    "depth": 0.738911,
    "height": 0.383252,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-019",
    "name": "Slim coffee table",
    "category": "tables",
    "width": 1.572919,
    "depth": 0.684666,
    "height": 0.270265,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-coffee-table-022",
    "name": "Slate coffee table",
    "category": "tables",
    "width": 0.91259,
    "depth": 0.91259,
    "height": 0.302661,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-001",
    "name": "Walnut drawer cabinet",
    "category": "storage",
    "width": 1.224645,
    "depth": 0.60242,
    "height": 0.728793,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-010",
    "name": "Open graphite shelf",
    "category": "storage",
    "width": 1.172773,
    "depth": 0.371065,
    "height": 0.704868,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-020",
    "name": "Tall display shelf",
    "category": "storage",
    "width": 0.942505,
    "depth": 0.303189,
    "height": 1.591772,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-026",
    "name": "Narrow bookcase",
    "category": "storage",
    "width": 0.503242,
    "depth": 0.328578,
    "height": 1.986001,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-028",
    "name": "Graphite bookcase",
    "category": "storage",
    "width": 0.93522,
    "depth": 0.579451,
    "height": 1.986272,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-030",
    "name": "White storage tower",
    "category": "storage",
    "width": 0.724194,
    "depth": 0.300045,
    "height": 1.221055,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-031",
    "name": "Office pigeonhole cabinet",
    "category": "storage",
    "width": 1.356707,
    "depth": 0.421111,
    "height": 0.925544,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-032",
    "name": "Powder blue bookcase",
    "category": "storage",
    "width": 0.628489,
    "depth": 0.311413,
    "height": 0.864751,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-036",
    "name": "Open oak shelving",
    "category": "storage",
    "width": 1.101733,
    "depth": 0.382173,
    "height": 0.703674,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-037",
    "name": "White drawer cabinet",
    "category": "storage",
    "width": 0.497659,
    "depth": 0.611038,
    "height": 0.658707,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-049",
    "name": "White bookcase",
    "category": "storage",
    "width": 1.026294,
    "depth": 0.402716,
    "height": 1.275164,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-shelf-066",
    "name": "Walnut sideboard",
    "category": "storage",
    "width": 0.818698,
    "depth": 0.439715,
    "height": 0.657043,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-lamp-floor-001",
    "name": "Adjustable task lamp",
    "category": "lighting",
    "width": 0.774146,
    "depth": 0.710776,
    "height": 2.203733,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-lamp-floor-002",
    "name": "White tripod lamp",
    "category": "lighting",
    "width": 0.57615,
    "depth": 0.558019,
    "height": 1.718286,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-lamp-floor-004",
    "name": "Graphite arc lamp",
    "category": "lighting",
    "width": 1.637832,
    "depth": 0.60828,
    "height": 2.23584,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-lamp-floor-006",
    "name": "Graphite tripod lamp",
    "category": "lighting",
    "width": 0.57615,
    "depth": 0.558019,
    "height": 1.718286,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-lamp-floor-007",
    "name": "Column floor lamp",
    "category": "lighting",
    "width": 0.435946,
    "depth": 0.435946,
    "height": 1.997309,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-lamp-floor-012",
    "name": "Double reading lamp",
    "category": "lighting",
    "width": 0.811006,
    "depth": 0.521303,
    "height": 2.03952,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-partitions-005",
    "name": "Walnut slat divider",
    "category": "architecture",
    "width": 1.930364,
    "depth": 0.149996,
    "height": 1,
    "resize": "footprint",
    "collidable": true
  },
  {
    "id": "office-partitions-039",
    "name": "Graphite privacy panel",
    "category": "architecture",
    "width": 1.892686,
    "depth": 0.064324,
    "height": 0.749641,
    "resize": "footprint",
    "collidable": true
  },
  {
    "id": "office-partitions-048",
    "name": "Grey privacy panel",
    "category": "architecture",
    "width": 1.892686,
    "depth": 0.064324,
    "height": 0.749641,
    "resize": "footprint",
    "collidable": true
  },
  {
    "id": "office-partitions-055",
    "name": "White slat divider",
    "category": "architecture",
    "width": 4,
    "depth": 0.079304,
    "height": 0.780952,
    "resize": "footprint",
    "collidable": true
  },
  {
    "id": "office-partitions-057",
    "name": "White privacy panel",
    "category": "architecture",
    "width": 1.892686,
    "depth": 0.064324,
    "height": 0.749641,
    "resize": "footprint",
    "collidable": true
  },
  {
    "id": "office-floor-004",
    "name": "Walnut floor finish",
    "category": "architecture",
    "width": 4,
    "depth": 4,
    "height": 0.001,
    "resize": "footprint",
    "collidable": false
  },
  {
    "id": "office-floor-009",
    "name": "Slate tile finish",
    "category": "architecture",
    "width": 4,
    "depth": 4,
    "height": 0.001,
    "resize": "footprint",
    "collidable": false
  },
  {
    "id": "office-floor-014",
    "name": "White tile finish",
    "category": "architecture",
    "width": 4,
    "depth": 4,
    "height": 0.001,
    "resize": "footprint",
    "collidable": false
  },
  {
    "id": "office-floor-018",
    "name": "Oak floor finish",
    "category": "architecture",
    "width": 4,
    "depth": 3.991195,
    "height": 0.001,
    "resize": "footprint",
    "collidable": false
  },
  {
    "id": "office-floor-020",
    "name": "Sand tile finish",
    "category": "architecture",
    "width": 4,
    "depth": 4,
    "height": 0.001,
    "resize": "footprint",
    "collidable": false
  },
  {
    "id": "office-plant-001",
    "name": "Rubber plant in white planter",
    "category": "plants",
    "width": 1.04574,
    "depth": 0.600553,
    "height": 1.617445,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-plant-002",
    "name": "Dracaena in slate planter",
    "category": "plants",
    "width": 0.656681,
    "depth": 0.588726,
    "height": 1.530354,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-plant-022",
    "name": "Snake plant in graphite planter",
    "category": "plants",
    "width": 0.50102,
    "depth": 0.469707,
    "height": 1.331563,
    "resize": "uniform",
    "collidable": true
  },
  {
    "id": "office-plant-023",
    "name": "Palm in white planter",
    "category": "plants",
    "width": 0.975098,
    "depth": 0.922841,
    "height": 1.766627,
    "resize": "uniform",
    "collidable": true
  }
];
const byId=new Map(OFFICE_CATALOG.map(asset=>[asset.id,asset]));
export function getOfficeAsset(id:string):OfficeAssetDefinition|undefined {return byId.get(id);}
