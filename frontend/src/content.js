// Textos de la app (tomados de la versión publicada), reportes de ejemplo y avisos.

const DEMO_ROWS = [
  [`areas`, `Árbol que requiere poda`, `Av. Dorsal`, -33.3962, -70.6761],
  [`limpieza`, `Microbasural`, `Sector El Cortijo`, -33.3725, -70.688],
  [`calles`, `Pavimento en mal estado`, `Sector Av. Independencia`, -33.3851, -70.6793],
  [`iluminacion`, `Luminaria apagada`, `Sector Vivaceta`, -33.3937, -70.6845],
  [`agua`, `Fuga de agua`, `Sector Av. Zapadores`, -33.3842, -70.6672],
  [`transito`, `Señalética dañada`, `Sector Av. Independencia`, -33.3771, -70.6799],
  [`mobiliario`, `Banca o escaño en mal estado`, `Pedro Fontova`, -33.3781, -70.6677],
  [`deporte`, `Multicancha en mal estado`, `Sector central de Conchalí`, -33.3873, -70.6744],
  [`transporte`, `Paradero dañado`, `Sector Av. Dorsal`, -33.3965, -70.6692],
  [`areas`, `Problemas de riego`, `Sector El Cortijo`, -33.3745, -70.6805],
  [`limpieza`, `Escombros en la vía pública`, `Sector poniente de Conchalí`, -33.3861, -70.6902],
  [`iluminacion`, `Iluminación insuficiente`, `Sector oriente de Conchalí`, -33.3825, -70.6595],
];

/** Reportes ficticios que se muestran con «Ver ejemplos». No se guardan en el servidor. */
export const DEMO_REPORTS = DEMO_ROWS.map((row, i) => ({
  id: `DEMO-${String(i + 1).padStart(3, '0')}`,
  category: row[0],
  detail: row[1],
  address: row[2],
  lat: row[3],
  lng: row[4],
  description: 'Este es un reporte de ejemplo para explorar el mapa. No corresponde a un reclamo verificado.',
  createdAt: '2026-09-11T12:00:00-03:00',
  demo: true,
  photos: [],
}));

export const LEGAL = {
  about: [
    `¿Qué es AFM?`,
    `AFM — Aquí falta la muni es una herramienta ciudadana para hacer visibles los problemas que vemos todos los días en Conchalí.`,
    `Una calle en mal estado, una luminaria apagada, un microbasural, una plaza abandonada o ese problema del barrio que hemos visto tantas veces y sigue ahí.`,
    `Cada reporte nos ayuda a construir un mapa de lo que falta en Conchalí y a conocer, desde la experiencia de sus propios vecinos, cuáles son las necesidades y prioridades de nuestros barrios.`,
    `AFM no es un canal municipal ni reemplaza los mecanismos oficiales para realizar solicitudes, reclamos o denuncias ante las instituciones correspondientes.`,
    `¿Cómo funciona?`,
    `1. Elige el problema`,
    `Selecciona la categoría que mejor representa lo que quieres reportar.`,
    `2. Ponlo en el mapa`,
    `Indica el lugar exacto donde está ocurriendo.`,
    `3. Guarda tu reporte`,
    `Registra tu reporte y súmalo al mapa ciudadano de Conchalí.`,
  ],
  faq: [
    `1. ¿Esto es un canal municipal?`,
    `No. AFM es una herramienta ciudadana independiente y no reemplaza los canales oficiales de atención, solicitudes, reclamos o denuncias.`,
    `2. ¿Quién puede reportar?`,
    `Quienes viven, trabajan, estudian o visitan Conchalí y quieren hacer visible un problema de la comuna.`,
    `3. ¿Necesito una fotografía?`,
    `Sí. Una fotografía ayuda a mostrar mejor lo que está pasando. Puedes añadir hasta dos imágenes JPG, PNG o WebP, de hasta 5 MB cada una.`,
    `4. ¿Puedo consultar mi reporte después?`,
    `Sí. Puedes consultar los reportes que has realizado desde la sección “Mis reportes”.`,
    `5. ¿Qué significan los números en el mapa?`,
    `Representan varios reportes cercanos. Toca el grupo o acerca el mapa para ver cada uno.`,
    `6. ¿AFM solucionará el problema que reporte?`,
    `No. AFM permite registrar y hacer visibles los problemas de Conchalí, pero no gestiona ni resuelve directamente los reportes.`,
    `7. ¿Mis datos personales serán públicos?`,
    `No. Tu nombre, apellido y WhatsApp no se mostrarán públicamente en el mapa ni en el detalle de tu reporte.`,
  ],
  contact: [
    `¿Tienes alguna duda sobre AFM?`,
    `Si tienes consultas sobre la plataforma, el uso de tus datos o necesitas comunicarte con nosotros, puedes escribirnos a:`,
    `contacto@afmconchali.cl`,
    `Importante: este canal es para consultas relacionadas con AFM. Los problemas de la comuna deben registrarse a través de la opción “Hacer un reporte”.`,
  ],
  profile: [
    `Tus reportes, en un solo lugar.`,
    `Aquí puedes consultar los reportes que has realizado y volver a ver su información cuando lo necesites.`,
    `Tus datos personales no son públicos. Tu nombre, apellido y WhatsApp no aparecen en el mapa ni en el detalle público de tus reportes.`,
    `Ver mis reportes →`,
  ],
  privacy: [
    `Tus datos y tu privacidad`,
    `Para realizar un reporte, AFM solicita tu nombre, apellido, WhatsApp y tu relación con Conchalí y con el sector reportado. Estos datos permiten identificar el origen de los reportes y conocer mejor las necesidades de los distintos barrios de la comuna.`,
    `Tu nombre, apellido y WhatsApp no serán publicados ni aparecerán en el mapa o en el detalle público de tus reportes.`,
    `Información de los reportes`,
    `Los reportes realizados en AFM podrán ser visibles públicamente e incluirán la categoría y tipo de problema, ubicación, fecha, descripción y fotografías que hayas incorporado.`,
    `Ubicación y mapa`,
    `AFM utiliza servicios de mapas y geolocalización para permitirte ubicar el lugar del reporte. El acceso a la ubicación de tu dispositivo solo se solicitará cuando utilices esa función y requerirá tu autorización.`,
    `Uso de la información`,
    `La información recopilada a través de los reportes podrá ser utilizada para identificar problemas, necesidades y prioridades de los distintos barrios de Conchalí y construir una mirada general sobre lo que ocurre en la comuna.`,
    `AFM es una herramienta ciudadana independiente. No es un canal municipal y los reportes realizados en la plataforma no constituyen solicitudes, reclamos o denuncias ingresadas ante la Municipalidad u otros organismos públicos.`,
    `Normas de uso`,
    `AFM es un espacio ciudadano y debe utilizarse con respeto. Los reportes deben referirse a problemas de la comuna y describir situaciones reales de manera responsable.`,
    `No se permite publicar contenido que incluya insultos, amenazas, llamados a la violencia, expresiones de odio, discriminación, acoso o contenido destinado a atacar o exponer a otras personas.`,
    `Tampoco deben incorporarse datos personales de terceros que no sean necesarios para identificar el problema, especialmente rostros, nombres, teléfonos, domicilios o patentes de vehículos.`,
    `AFM podrá moderar y eliminar los reportes, textos o fotografías que incumplan estas normas de uso.`,
    `Aceptación`,
    `Al realizar un reporte, declaras conocer y aceptar estas condiciones y autorizas la publicación de la información, descripción, ubicación y fotografías asociadas al reporte, con exclusión de tus datos personales de contacto.`,
  ],
};

/** Aviso que acompaña a los textos informativos (antes decía «Piloto local…»). */
export const SERVICE_NOTICE =
  'Los reportes se publican en el mapa ciudadano de AFM. Tus datos de contacto solo los ve el equipo de moderación de AFM. Los reportes no se envían a la municipalidad.';

export const PRIVACY_EXTRA =
  ' La información se almacena en servidores de Amazon Web Services (AWS). El mapa consulta imágenes de OpenStreetMap y la búsqueda de direcciones envía el texto a Nominatim.';

/** Líneas de LEGAL que se muestran como subtítulo. */
export const LEGAL_HEADINGS = new Set([
  '¿Qué es AFM?',
  '¿Cómo funciona?',
  'Tus reportes, en un solo lugar.',
  '¿Tienes alguna duda sobre AFM?',
  'Tus datos y tu privacidad',
  'Información de los reportes',
  'Ubicación y mapa',
  'Uso de la información',
  'Normas de uso',
  'Aceptación',
]);

export const LEGAL_TITLES = {
  about: '¿Qué es AFM?',
  privacy: 'Términos y privacidad',
  rules: 'Normas de uso de AFM',
  profile: 'Tu espacio en AFM',
  faq: 'Preguntas frecuentes',
  categories: 'Categorías y ejemplos',
  contact: 'Contacto',
};
