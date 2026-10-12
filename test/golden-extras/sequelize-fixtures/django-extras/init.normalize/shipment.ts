import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Account } from './account.js';
import type { ContentType } from './contentType.js';
import type { Item } from './item.js';

export class Shipment extends Model<
  InferAttributes<Shipment>,
  InferCreationAttributes<Shipment>
> {
  declare id: CreationOptional<string>;
  declare objectId: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare itemId: string;
  declare otherId: string;
  declare contentTypeId: string;
  declare createdById: string;

  declare item?: NonAttribute<Item>;
  declare other?: NonAttribute<Item>;
  declare contentType?: NonAttribute<ContentType>;
  declare createdBy?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Shipment {
    Shipment.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        objectId: { type: DataTypes.INTEGER, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        itemId: { type: DataTypes.UUID, allowNull: false },
        otherId: { type: DataTypes.UUID, allowNull: false },
        contentTypeId: { type: DataTypes.UUID, allowNull: false },
        createdById: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Shipment',
        tableName: 'shipment',
        timestamps: true,
        underscored: true,
      }
    );
    return Shipment;
  }
}
