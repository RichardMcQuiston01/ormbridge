import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  BelongsTo,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';
import { ContentType } from './contentType.js';
import { Item } from './item.js';

@Table({ tableName: 'blog_shipment', timestamps: false })
export class Shipment extends Model<
  InferAttributes<Shipment>,
  InferCreationAttributes<Shipment>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare object_id: number;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare item_id: number;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare other_id: number;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare content_type_id: number;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare created_by_id: number;

  @BelongsTo(() => Item, {
    foreignKey: { name: 'item_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'shipments' },
  })
  declare item?: NonAttribute<Item>;

  @BelongsTo(() => Item, {
    foreignKey: { name: 'other_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'other_shipments' },
  })
  declare other?: NonAttribute<Item>;

  @BelongsTo(() => ContentType, {
    foreignKey: { name: 'content_type_id', onDelete: 'CASCADE' },
  })
  declare content_type?: NonAttribute<ContentType>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'created_by_id', onDelete: 'CASCADE' },
  })
  declare created_by?: NonAttribute<Account>;
}
