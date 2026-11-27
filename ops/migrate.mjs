import {openDatabase} from '../src/database.mjs';
const db=await openDatabase();try{console.log('MongoDB schema/indexes ready.');}finally{await db.close();}
