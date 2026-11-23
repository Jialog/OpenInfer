// Whether a version's files (DISK bytes) fit a device's free disk, by the bytes known to be missing: all of them, unless
// the device has folders of the user's own model files (`local_model_folders`); then what is missing is known only once its
// preparation checked the files, and that preparation checks it against the free disk before any download. The files'
// total is never added back to the free disk. One rule for Placement, the disk check and the website's version menu.
export const diskFits=(inventory:{local_model_folders?:boolean,disk_available_bytes:string},disk:bigint)=>!!inventory.local_model_folders||disk<=BigInt(inventory.disk_available_bytes);
