/**
 * Name pools for persona voices. Plain data only: the picker reads these tables and makes no
 * judgements about which names are "right". Every name is invented for this product.
 */
export const NAME_POOLS = Object.freeze({
  indian: {
    female: ['Anika', 'Priya', 'Meera', 'Divya'],
    male: ['Arjun', 'Rohan', 'Vikram', 'Nikhil'],
    neutral: ['Kiran', 'Devi', 'Arya'],
    last: ['Rao', 'Sharma', 'Iyer', 'Nair'],
  },
  nigerian: {
    female: ['Adaeze', 'Chiamaka', 'Funmilayo', 'Zainab'],
    male: ['Chinedu', 'Emeka', 'Tunde', 'Ibrahim'],
    neutral: ['Kemi', 'Obi', 'Sade'],
    last: ['Okonkwo', 'Adeyemi', 'Bello', 'Nwosu'],
  },
  irish: {
    female: ['Aoife', 'Niamh', 'Ciara', 'Saoirse'],
    male: ['Cian', 'Declan', 'Eoin', 'Ronan'],
    neutral: ['Riordan', 'Keegan', 'Aisling'],
    last: ['Byrne', 'O\'Connor', 'Kelly', 'Murphy'],
  },
  scottish: {
    female: ['Isla', 'Fiona', 'Mairi', 'Eilidh'],
    male: ['Callum', 'Struan', 'Ewan', 'Alasdair'],
    neutral: ['Ainsley', 'Moray', 'Lennox'],
    last: ['MacLeod', 'Fraser', 'Buchanan', 'Sinclair'],
  },
  australian: {
    female: ['Matilda', 'Chloe', 'Ruby', 'Imogen'],
    male: ['Jarrah', 'Lachlan', 'Darcy', 'Beau'],
    neutral: ['Kirra', 'Bailey', 'Harper'],
    last: ['Whitfield', 'Hargreaves', 'Nolan', 'Brierley'],
  },
  'south african': {
    female: ['Thandiwe', 'Lerato', 'Annelie', 'Nomvula'],
    male: ['Sipho', 'Johan', 'Thabo', 'Pieter'],
    neutral: ['Zanele', 'Rudi', 'Lesedi'],
    last: ['Mokoena', 'van der Merwe', 'Dlamini', 'Botha'],
  },
  spanish: {
    female: ['Lucia', 'Marta', 'Carmen', 'Elena'],
    male: ['Javier', 'Alvaro', 'Diego', 'Sergio'],
    neutral: ['Cruz', 'Guadalupe', 'Sol'],
    last: ['Fernandez', 'Ortega', 'Rivas', 'Delgado'],
  },
  chinese: {
    female: ['Mei', 'Ling', 'Xiu', 'Yan'],
    male: ['Wei', 'Jun', 'Hao', 'Ming'],
    neutral: ['An', 'Lin', 'Yu'],
    last: ['Chen', 'Wang', 'Liu', 'Zhao'],
  },
  french: {
    female: ['Camille', 'Elodie', 'Margaux', 'Anais'],
    male: ['Thibault', 'Julien', 'Mathis', 'Gaspard'],
    neutral: ['Alix', 'Sacha', 'Noe'],
    last: ['Moreau', 'Lefevre', 'Girard', 'Rousseau'],
  },
  german: {
    female: ['Lena', 'Annika', 'Katrin', 'Franziska'],
    male: ['Jonas', 'Lukas', 'Matthias', 'Felix'],
    neutral: ['Toni', 'Luca', 'Mika'],
    last: ['Schneider', 'Vogel', 'Hartmann', 'Krause'],
  },
  italian: {
    female: ['Giulia', 'Chiara', 'Sofia', 'Alessia'],
    male: ['Matteo', 'Lorenzo', 'Marco', 'Davide'],
    neutral: ['Ari', 'Sasha', 'Celeste'],
    last: ['Ricci', 'Bianchi', 'Conti', 'Greco'],
  },
  japanese: {
    female: ['Yui', 'Hana', 'Sakura', 'Emi'],
    male: ['Haruto', 'Ren', 'Kaito', 'Sota'],
    neutral: ['Akira', 'Hikaru', 'Kaoru'],
    last: ['Sato', 'Kobayashi', 'Hayashi', 'Mori'],
  },
  korean: {
    female: ['Seoyeon', 'Jiwon', 'Hana', 'Minji'],
    male: ['Minho', 'Jaehyun', 'Seojun', 'Doyun'],
    neutral: ['Eun', 'Sun', 'Hyun'],
    last: ['Kim', 'Park', 'Choi', 'Jung'],
  },
  brazilian: {
    female: ['Beatriz', 'Mariana', 'Larissa', 'Camila'],
    male: ['Tiago', 'Rafael', 'Bruno', 'Caio'],
    neutral: ['Lu', 'Ariel', 'Sasha'],
    last: ['Almeida', 'Ferreira', 'Costa', 'Rocha'],
  },
  mexican: {
    female: ['Ximena', 'Valeria', 'Renata', 'Paloma'],
    male: ['Emiliano', 'Santiago', 'Rodrigo', 'Iker'],
    neutral: ['Guadalupe', 'Angel', 'Sol'],
    last: ['Hernandez', 'Vargas', 'Cruz', 'Navarro'],
  },
});

/** Broad American and British accents: a deliberately diverse pool, not a regional one. */
export const DIVERSE_POOL = Object.freeze({
  female: ['Naomi', 'Priya', 'Simone', 'Daniela', 'Amara', 'Meilin', 'Farah', 'Rosa'],
  male: ['Marcus', 'Dev', 'Andre', 'Tomas', 'Kofi', 'Hiro', 'Omar', 'Diego'],
  neutral: ['Alex', 'Sam', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Taylor', 'Rowan'],
  last: ['Okafor', 'Nguyen', 'Patel', 'Silva', 'Cohen', 'Kim', 'Mensah', 'Rivera'],
});

/** Gender-neutral first names for voices whose gender label is neutral or missing. */
export const NEUTRAL_FIRST_NAMES = Object.freeze([
  'Alex', 'Sam', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Taylor', 'Rowan', 'Ariel', 'Quinn',
]);
