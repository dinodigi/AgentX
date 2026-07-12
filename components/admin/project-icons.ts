import {
  Rocket, Store, ShoppingBag, ShoppingCart, Camera, Book, BookOpen, Code2, Music, Coffee,
  Leaf, Palette, Box, Boxes, Building2, Globe, Heart, Star, Zap, Flame,
  Cloud, Cpu, Database, Utensils, Dumbbell, Plane, Car, Home, Briefcase, GraduationCap,
  Stethoscope, Scissors, Wrench, Hammer, Paintbrush, Gamepad2, Headphones, Film, Mic, Feather,
  Gem, Crown, Sparkles, Bike, Ship, Wine, Gift, Anchor, Compass, Map,
  Newspaper, Factory, Sun, Moon,
  type LucideIcon,
} from "lucide-react";

/**
 * The curated project-icon set (Appearance tab). A focused, recognizable
 * selection instead of the full ~1,500 lucide catalog — keeps the picker
 * scannable and the client bundle light. `branding.icon` stores the key; the
 * BrandTile renders it, falling back to the letter monogram. Logo uploads were
 * retired (per-tenant sizing/cropping variance wasn't worth it).
 */
export const PROJECT_ICONS: Record<string, LucideIcon> = {
  rocket: Rocket, store: Store, "shopping-bag": ShoppingBag, "shopping-cart": ShoppingCart, camera: Camera,
  book: Book, "book-open": BookOpen, code: Code2, music: Music, coffee: Coffee,
  leaf: Leaf, palette: Palette, box: Box, boxes: Boxes, building: Building2,
  globe: Globe, heart: Heart, star: Star, zap: Zap, flame: Flame,
  cloud: Cloud, cpu: Cpu, database: Database, utensils: Utensils, dumbbell: Dumbbell,
  plane: Plane, car: Car, home: Home, briefcase: Briefcase, "graduation-cap": GraduationCap,
  stethoscope: Stethoscope, scissors: Scissors, wrench: Wrench, hammer: Hammer, paintbrush: Paintbrush,
  gamepad: Gamepad2, headphones: Headphones, film: Film, mic: Mic, feather: Feather,
  gem: Gem, crown: Crown, sparkles: Sparkles, bike: Bike, ship: Ship,
  wine: Wine, gift: Gift, anchor: Anchor, compass: Compass, map: Map,
  newspaper: Newspaper, factory: Factory, sun: Sun, moon: Moon,
};

export const PROJECT_ICON_NAMES = Object.keys(PROJECT_ICONS);

export function projectIcon(name: string | null | undefined): LucideIcon | null {
  return name ? PROJECT_ICONS[name] ?? null : null;
}
