import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Shipment } from './shipment.js';

export class Item extends Model<
  InferAttributes<Item>,
  InferCreationAttributes<Item>
> {
  declare id: CreationOptional<string>;
  declare firstName: string;
  declare lastName: string;
  declare fullName: string;
  declare quantity: CreationOptional<number>;
  declare totalCents: number;
  declare tags: CreationOptional<string[]>;
  declare grid: CreationOptional<number[][] | null>;
  declare kinds: CreationOptional<('tool' | 'toy')[]>;
  declare attributes: CreationOptional<Record<string, string | null>>;
  declare stockRange: CreationOptional<unknown | null>;
  declare bigRange: CreationOptional<unknown | null>;
  declare priceRange: CreationOptional<unknown | null>;
  declare available: CreationOptional<unknown | null>;
  declare validDuring: CreationOptional<unknown | null>;
  declare lastIp: CreationOptional<string | null>;
  declare legacyIp: CreationOptional<string | null>;
  declare shelfLife: CreationOptional<string | null>;
  declare sourcePath: CreationOptional<string | null>;
  declare manual: CreationOptional<string | null>;
  declare photo: CreationOptional<string | null>;
  declare smallCount: CreationOptional<number>;
  declare tinyCount: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare stockedAt: CreationOptional<Date>;
  declare priority: CreationOptional<number>;
  declare note: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare shipments?: NonAttribute<Shipment[]>;
  declare otherShipments?: NonAttribute<Shipment[]>;

  static initModel(sequelize: Sequelize): typeof Item {
    Item.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        firstName: { type: DataTypes.STRING(40), allowNull: false },
        lastName: { type: DataTypes.STRING(40), allowNull: false },
        fullName: { type: DataTypes.STRING(81), allowNull: false },
        quantity: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        totalCents: { type: DataTypes.INTEGER, allowNull: false },
        tags: {
          type: DataTypes.ARRAY(DataTypes.STRING(20)),
          allowNull: false,
          defaultValue: [],
        },
        grid: DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)),
        kinds: {
          type: DataTypes.ARRAY(DataTypes.ENUM('tool', 'toy')),
          allowNull: false,
          defaultValue: [],
        },
        attributes: {
          type: DataTypes.HSTORE,
          allowNull: false,
          defaultValue: {},
        },
        stockRange: DataTypes.RANGE(DataTypes.INTEGER),
        bigRange: DataTypes.RANGE(DataTypes.BIGINT),
        priceRange: DataTypes.RANGE(DataTypes.DECIMAL),
        available: DataTypes.RANGE(DataTypes.DATEONLY),
        validDuring: DataTypes.RANGE(DataTypes.DATE),
        lastIp: DataTypes.INET,
        legacyIp: { type: DataTypes.INET, unique: true },
        shelfLife: DataTypes.BIGINT,
        sourcePath: DataTypes.STRING(100),
        manual: DataTypes.STRING(100),
        photo: DataTypes.STRING(100),
        smallCount: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        tinyCount: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        isActive: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        stockedAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        priority: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 5,
        },
        note: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'none',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Item',
        tableName: 'item',
        timestamps: true,
        underscored: true,
      }
    );
    return Item;
  }
}
