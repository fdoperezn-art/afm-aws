import {
  createElement, Trash2, Construction, Lightbulb, Trees, Droplets, TrafficCone, Armchair, Volleyball, ShieldCheck,
  Building2, BusFront, CircleAlert, ArrowUpRight, ArrowRight, ArrowLeft, Plus, X, Menu, MapPin, Map, Filter, Search,
  Locate, FileText, Info, User, Camera, Check, ChevronRight, ChevronDown, Download, Lock, Heart, Clock, Layers, Mail,
  HardHat, LogOut, RefreshCw, Flag, Eye,
} from 'lucide';

const ICONS = {
  'trash-2': Trash2, construction: Construction, lightbulb: Lightbulb, trees: Trees, droplets: Droplets,
  'traffic-cone': TrafficCone, armchair: Armchair, volleyball: Volleyball, 'shield-check': ShieldCheck,
  'building-2': Building2, 'bus-front': BusFront, 'circle-alert': CircleAlert, 'arrow-up-right': ArrowUpRight,
  'arrow-right': ArrowRight, 'arrow-left': ArrowLeft, plus: Plus, x: X, menu: Menu, 'map-pin': MapPin, map: Map,
  filter: Filter, search: Search, locate: Locate, reports: FileText, info: Info, user: User, camera: Camera,
  check: Check, 'chevron-right': ChevronRight, 'chevron-down': ChevronDown, download: Download, lock: Lock,
  heart: Heart, clock: Clock, layers: Layers, mail: Mail, 'hard-hat': HardHat, 'log-out': LogOut,
  refresh: RefreshCw, flag: Flag, eye: Eye,
};

/** Devuelve el SVG de un ícono como texto HTML. */
export const icon = (name, size = 20) =>
  createElement(ICONS[name] || CircleAlert, {
    width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true',
  }).outerHTML;

/** Señal vial con el ícono de la categoría. */
export const roadSign = (name, extraClass = '') =>
  `<span class="road-sign ${extraClass}"><span>${icon(name, 25)}</span></span>`;
