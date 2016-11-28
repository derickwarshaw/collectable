import {CONST, nextId, isDefined, abs, min, copyArray, normalizeArrayIndex, shiftDownRoundUp, log} from './common';

export const enum SLOT_STATUS {
  NO_CHANGE = 0,
  RESERVE = 1,
  RELEASE = 2,
}

export type ChildSlotOutParams<T> = {
  slot: T|Slot<T>,
  index: number,
  offset: number
};

export class Slot<T> {
  public id = nextId();
  constructor(
    public group: number,
    public size: number, // the total number of descendent elements
    public sum: number, // the total accumulated size at this slot
    public recompute: number, // the number of child slots for which the sum must be recalculated
    public subcount: number, // the total number of slots belonging to immediate child slots
    public slots: (Slot<T>|T)[]
  ) {
log(`construct new slot ${this.id}`);
  }

  static empty<T>(): Slot<T> {
    return emptySlot;
  }

  shallowCloneWithStatus(status: SLOT_STATUS): Slot<T> {
    var group = status === SLOT_STATUS.NO_CHANGE ? this.group
              : status === SLOT_STATUS.RELEASE ? abs(this.group)
              : this.group < 0 ? this.group : -this.group;
    var slot = new Slot<T>(group, this.size, this.sum, this.recompute, this.subcount, this.slots);
log(`slot ${this.id} shallow-cloned with id ${slot.id} and group ${slot.group}`);
    return slot;
  }

  shallowCloneToGroup(group: number): Slot<T> {
    return new Slot<T>(group, this.size, this.sum, this.recompute, this.subcount, this.slots);
  }

  cloneToGroup(group: number): Slot<T> {
    return new Slot<T>(group, this.size, this.sum, this.recompute, this.subcount, copyArray(this.slots));
  }

  cloneAsReservedNode(group: number): Slot<T> {
    return this.cloneToGroup(-abs(group));
  }

  cloneAsPlaceholder(group: number): Slot<T> {
    var slot = new Slot<T>(-abs(group), this.size, this.sum, this.recompute, this.subcount, new Array<T>(this.slots.length));
log(`slot ${this.id} cloned as placeholder with id ${slot.id} and group ${slot.group}`);
    return slot;
  }

  cloneWithAdjustedRange(group: number, padLeft: number, padRight: number, isLeaf: boolean): Slot<T> {
    var src = this.slots;
    var slots = new Array<T|Slot<T>>(src.length + padLeft + padRight);
    var dest = new Slot<T>(group, 0, 0, isLeaf ? -1 : 0, 0, slots);
    adjustSlotBounds(this, dest, padLeft, padRight, isLeaf);
    return dest;
  }

  adjustRange(padLeft: number, padRight: number, isLeaf: boolean): void {
    adjustSlotBounds(this, this, padLeft, padRight, isLeaf);
  }

  // editableChild(slotIndex: number): Slot<T> {
  //   var slot = <Slot<T>>this.slots[slotIndex];
  //   if(slot.group !== this.group) {
  //     slot = slot.cloneToGroup(this.group);
  //     this.slots[slotIndex] = slot;
  //   }
  //   return slot;
  // }

  createParent(group: number, status: SLOT_STATUS, expand?: ExpansionState): Slot<T> {
    var childSlot: Slot<T> = this;
    if(status === SLOT_STATUS.RELEASE) {
      childSlot = childSlot.prepareForRelease(group);
    }
    else if(status === SLOT_STATUS.RESERVE) {
      childSlot = this.cloneAsPlaceholder(group);
    }
    var slotCount = 1, nodeSize = this.size, slotIndex = 0;
    if(isDefined(expand)) {
      slotCount += expand.addedSlots;
      nodeSize += expand.addedSize;
      if(expand.prepend) {
        slotIndex = slotCount - 1;
      }
    }
log(`slot count for new parent is: ${slotCount}`);

    var slots = new Array<Slot<T>>(slotCount);
    slots[slotIndex] = childSlot;
    return new Slot<T>(group, nodeSize, 0, this.recompute === -1 ? -1 : slotCount, this.slots.length, slots);
  }

  isReserved(): boolean {
    return this.group < 0;
  }

  isReservedFor(group: number): boolean {
    return this.group === -group;
  }

  isRelaxed(): boolean {
    return this.recompute !== -1;
  }

  isEditable(group: number): boolean {
    return abs(this.group) === group;
  }

  calculateSlotsToAdd(totalSlotsToAdd: number): number {
    return calculateSlotsToAdd(this.slots.length, totalSlotsToAdd);
  }

  calculateRecompute(slotCountDelta: number): number {
    return this.recompute === -1 ? -1 : this.recompute + slotCountDelta;
  }

  isSubtreeFull(shift: number): boolean {
    return this.slots.length << shift === this.size;
  }

  prepareForRelease(currentGroup: number): Slot<T> {
    if(this.group === -currentGroup) {
      this.group = -currentGroup;
      return this;
    }
    return this.group < 0 ? this.shallowCloneWithStatus(SLOT_STATUS.RELEASE) : this;
  }

  updatePlaceholder(actual: Slot<T>): void {
    this.size = actual.size;
    this.subcount = actual.subcount;
    this.recompute = actual.recompute;
    this.sum = actual.sum;
    this.slots.length = actual.slots.length;
  }

  reserveChildAtIndex(slotIndex: number): Slot<T> {
    var index = normalizeArrayIndex(this.slots, slotIndex);
    var slot = <Slot<T>>this.slots[index];
    this.slots[index] = slot.cloneAsPlaceholder(slot.group);
    return slot;
  }

  resolveChild(ordinal: number, shift: number, out: ChildSlotOutParams<T>): boolean {
    if(shift === 0) {
      if(ordinal >= this.slots.length) return false;
log(`OUT SLOT ASSIGNED (A)`);
      out.slot = this.slots[ordinal];
      out.index = ordinal;
      out.offset = 0;
      return true;
    }

    var slotIndex = (ordinal >>> shift) & CONST.BRANCH_INDEX_MASK;
    if(slotIndex >= this.slots.length) return false;

    if(this.recompute === -1) {
log(`OUT SLOT ASSIGNED (B)`);
      out.slot = <Slot<T>>this.slots[slotIndex];
      out.index = slotIndex;
      out.offset = slotIndex << shift;
      return true;
    }

    var invalidFromIndex = this.slots.length - this.recompute;
    var slot: Slot<T>, i: number;
    if(slotIndex < invalidFromIndex) {
      do {
        slot = <Slot<T>>this.slots[slotIndex];
      } while(ordinal >= slot.sum && slotIndex < invalidFromIndex && ++slotIndex);
      if(slotIndex < invalidFromIndex) {
log(`OUT SLOT ASSIGNED (C)`);
        out.slot = slot;
        out.index = slotIndex;
        out.offset = slotIndex === 0 ? 0 : (<Slot<T>>this.slots[slotIndex - 1]).sum;
        return true;
      }
    }

    var slotCap = 1 << shift;
    var maxSum = slotCap * invalidFromIndex;
    var sum = invalidFromIndex === 0 ? 0 : (<Slot<T>>this.slots[invalidFromIndex - 1]).sum;
    var lastIndex = this.slots.length - 1;
    var found = false;
    this.recompute = 0;

    for(i = invalidFromIndex; i <= lastIndex; i++) {
      if(i === lastIndex && sum === maxSum) {
log(`recomputation determined that this is no longer a relaxed node`, sum, maxSum);
        this.recompute = -1;
        if(!found) {
          slot = <Slot<T>>this.slots[i];
          if(sum + slot.size > ordinal) {
log(`OUT SLOT ASSIGNED (D)`);
            out.slot = slot;
            out.index = i;
            out.offset = sum - slot.size;
            found = true;
          }
        }
      }
      else {
        slot = <Slot<T>>this.slots[i];
        sum += slot.size;
        maxSum += slotCap;

        if(slot.sum !== sum) {
          if(slot.group !== this.group) {
            this.slots[i] = slot = slot.shallowCloneWithStatus(SLOT_STATUS.NO_CHANGE);
          }
          slot.sum = sum;
log(`recomputed slot #${i} with sum ${sum}`);
        }

        if(!found && sum > ordinal) {
log(`OUT SLOT ASSIGNED (E)`);
          out.slot = slot;
          out.index = i;
          out.offset = sum - slot.size;
          found = true;
        }
      }
    }

    return found;
  }
}

function adjustSlotBounds<T>(src: Slot<T>, dest: Slot<T>, padLeft: number, padRight: number, isLeaf: boolean): void {
  var srcSlots = src.slots;
  var destSlots = dest.slots;
  var i: number, j: number, amount: number;
  if(padLeft < 0) {
    i = -padLeft;
    j = 0;
    amount = srcSlots.length + padLeft;
  }
  else {
    i = 0;
    j = padLeft;
    amount = srcSlots.length;
  }
  if(padRight < 0) {
    amount += padRight;
  }
  if(srcSlots === destSlots) {
    destSlots.length += padLeft + padRight;
  }
log(`[adjustSlotBounds] amount: ${amount}, original size: ${src.size}`);
  if(isLeaf) {
    for(var c = 0; c < amount; i++, j++, c++) {
      destSlots[j] = srcSlots[i];
    }
    dest.size = amount + padLeft + padRight;
  }
  else {
    var subcount = 0, size = 0;
    for(var c = 0; c < amount; i++, j++, c++) {
      var slot = <Slot<T>>srcSlots[i];
      subcount += slot.slots.length;
      size += slot.size;
      destSlots[j] = slot;
    }
    dest.size = size;
    dest.subcount = subcount;
    dest.recompute = padLeft === 0 ? src.recompute + padRight : destSlots.length;
  }
log(`[adjustSlotBounds] size updated to: ${dest.size}`);
}


/**
 * This class is used to help track and manage the parameters and output values required during the expansion of a set
 * of edge nodes over several iterative steps.
 *
 * @export
 * @class ExpansionState
 */
export class ExpansionState {
  addedSize = 0;
  addedSlots = 0;
  constructor(
    public totalSize: number,
    public remainingSize: number,
    public shift: number,
    public readonly prepend: boolean
  ) {
log(`[EXPANSION STATE] CONSTRUCT: remainingSize: ${remainingSize}, shift: ${shift}`);
  }

  next(originalSlotCount: number): void {
log(`[EXPANSION STATE] WAS: totalSize: ${this.totalSize}, remainingSize: ${this.remainingSize}, shift: ${this.shift}, addedSize: ${this.addedSize}, addedSlots: ${this.addedSlots}`);
    this.addedSlots = calculateSlotsToAdd(originalSlotCount, shiftDownRoundUp(this.remainingSize, this.shift));
    this.addedSize = min(this.remainingSize, this.addedSlots << this.shift);
    this.remainingSize -= this.addedSize;
log(`[EXPANSION STATE] IS NOW: totalSize: ${this.totalSize}, remainingSize: ${this.remainingSize}, shift: ${this.shift}, addedSize: ${this.addedSize}, addedSlots: ${this.addedSlots}`);
  }
}

export function calculateSlotsToAdd(initialSlotCount: number, totalAdditionalSlots: number): number {
  return min(CONST.BRANCH_FACTOR - initialSlotCount, totalAdditionalSlots);
}

export var emptySlot = new Slot<any>(nextId(), 0, 0, -1, 0, []);