import { db } from '../lib/db'
import { georefTasks, odmTasks } from '../lib/schema'

async function main() {
  console.log("=== Georef Tasks ===")
  const gTasks = await db.select().from(georefTasks)
  for (const t of gTasks) {
    console.log(`ID: ${t.id}, status: ${t.status}, outputKey: ${t.outputKey}, tilesKey: ${t.tilesKey}`)
  }

  console.log("\n=== ODM Tasks ===")
  const oTasks = await db.select().from(odmTasks)
  for (const t of oTasks) {
    console.log(`ID: ${t.id}, status: ${t.status}, outputKey: ${t.outputKey}, tilesKey: ${t.tilesKey}`)
  }
}

main().catch(console.error)
