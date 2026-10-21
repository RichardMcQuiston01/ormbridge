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
  BelongsTo,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';
import { ContentType } from './contentType.js';
import { Item } from './item.js';

@Table({ tableName: 'shipment', timestamps: true, underscored: true })
export class Shipment extends Model<
  InferAttributes<Shipment>,
  InferCreationAttributes<Shipment>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare objectId: number;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare itemId: string;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare otherId: string;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare contentTypeId: string;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare createdById: string;

  @BelongsTo(() => Item, {
    foreignKey: { name: 'itemId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'shipments' },
  })
  declare item?: NonAttribute<Item>;

  @BelongsTo(() => Item, {
    foreignKey: { name: 'otherId', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'otherShipments' },
  })
  declare other?: NonAttribute<Item>;

  @BelongsTo(() => ContentType, {
    foreignKey: { name: 'contentTypeId', onDelete: 'CASCADE' },
  })
  declare contentType?: NonAttribute<ContentType>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'createdById', onDelete: 'CASCADE' },
  })
  declare createdBy?: NonAttribute<Account>;
}
