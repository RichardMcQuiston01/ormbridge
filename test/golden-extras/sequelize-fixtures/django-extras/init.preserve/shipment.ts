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
  declare id: CreationOptional<number>;
  declare object_id: number;
  declare item_id: number;
  declare other_id: number;
  declare content_type_id: number;
  declare created_by_id: number;

  declare item?: NonAttribute<Item>;
  declare other?: NonAttribute<Item>;
  declare content_type?: NonAttribute<ContentType>;
  declare created_by?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Shipment {
    Shipment.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        object_id: { type: DataTypes.INTEGER, allowNull: false },
        item_id: { type: DataTypes.INTEGER, allowNull: false },
        other_id: { type: DataTypes.INTEGER, allowNull: false },
        content_type_id: { type: DataTypes.INTEGER, allowNull: false },
        created_by_id: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Shipment',
        tableName: 'blog_shipment',
        timestamps: false,
      }
    );
    return Shipment;
  }
}
