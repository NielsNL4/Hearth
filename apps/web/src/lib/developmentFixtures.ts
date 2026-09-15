export interface DevelopmentFixture {
  kind: 'map' | 'token';
  label: string;
  file: File;
}

const mapDefinition = { kind: 'map' as const, label: 'Hand-Drawn Dungeon', path: '/development/dungeon-map.jpg', fileName: 'dungeon-map.jpg' };
const tokenSource = '/development/fantasy-characters.png';
const tokenCrops = [
  { label: 'Vanguard', fileName: 'vanguard.png', column: 0, row: 0 },
  { label: 'Arcanist', fileName: 'arcanist.png', column: 1, row: 0 },
  { label: 'Beast', fileName: 'beast.png', column: 2, row: 0 },
] as const;

async function loadFixtureFile(path: string, fileName: string): Promise<File> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load development fixture ${path}.`);
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type });
}

async function loadFixtureImage(path: string): Promise<HTMLImageElement> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load development fixture ${path}.`);
  const sourceUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = sourceUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`The development fixture ${path} could not be decoded.`));
    });
    return image;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function cropToken(image: HTMLImageElement, column: number, row: number, fileName: string): Promise<File> {
  const columns = 6;
  const rows = 5;
  const width = Math.floor(image.naturalWidth / columns);
  const height = Math.floor(image.naturalHeight / rows);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable for development fixtures.');
  context.drawImage(image, column * width, row * height, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not encode development fixture.')), 'image/png'));
  return new File([blob], fileName, { type: 'image/png' });
}

export async function loadDevelopmentFixtures(): Promise<DevelopmentFixture[]> {
  const [mapFile, tokenImage] = await Promise.all([
    loadFixtureFile(mapDefinition.path, mapDefinition.fileName),
    loadFixtureImage(tokenSource),
  ]);
  const tokens = await Promise.all(tokenCrops.map(async (crop) => ({
    kind: 'token' as const,
    label: crop.label,
    file: await cropToken(tokenImage, crop.column, crop.row, crop.fileName),
  })));
  return [{ kind: mapDefinition.kind, label: mapDefinition.label, file: mapFile }, ...tokens];
}
