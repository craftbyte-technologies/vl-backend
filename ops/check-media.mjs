import '../src/environment.mjs';
import {openDatabase} from '../src/database.mjs';
import {openStorage} from '../src/storage.mjs';

let storage;
const db=await openDatabase();
try{
  storage=await openStorage(db);
  const [files,records,links]=await Promise.all([
    storage.list(),
    db.find('media'),
    db.find('listing_media')
  ]);
  const knownFiles=new Set(records.map(record=>record.stored_name));
  const knownIds=new Set(records.map(record=>record.id));
  const onDisk=new Set(files);
  const linked=new Set(links.map(link=>link.media_id));
  const report={
    missingFiles:records.filter(record=>!onDisk.has(record.stored_name)).map(record=>record.id),
    danglingLinks:links.filter(link=>!knownIds.has(link.media_id)).map(link=>link.listing_id),
    unattachedMedia:records.filter(record=>!linked.has(record.id)).map(record=>record.id),
    untrackedFiles:[...onDisk].filter(name=>/^[a-f0-9-]{36}\.(webp|pdf)$/.test(name)&&!knownFiles.has(name))
  };
  console.log(JSON.stringify(report,null,2));
  if(report.missingFiles.length||report.danglingLinks.length)process.exitCode=1;
}finally{storage?.close?.();await db.close();}
