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
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import type { Shipment } from './shipment.js';

@Table({ tableName: 'item', timestamps: true, underscored: true })
export class Item extends Model<
  InferAttributes<Item>,
  InferCreationAttributes<Item>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare firstName: string;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare lastName: string;

  @Attribute(DataTypes.STRING(81))
  @NotNull
  declare fullName: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(1)
  declare quantity: CreationOptional<number>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare totalCents: number;

  @Attribute(DataTypes.ARRAY(DataTypes.STRING(20)))
  @NotNull
  @Default([])
  declare tags: CreationOptional<string[]>;

  @Attribute(DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)))
  declare grid: CreationOptional<number[][] | null>;

  @Attribute(DataTypes.ARRAY(DataTypes.ENUM('tool', 'toy')))
  @NotNull
  @Default('[]')
  declare kinds: CreationOptional<('tool' | 'toy')[]>;

  @Attribute(DataTypes.HSTORE)
  @NotNull
  @Default({})
  declare attributes: CreationOptional<Record<string, string | null>>;

  @Attribute(DataTypes.RANGE(DataTypes.INTEGER))
  declare stockRange: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.BIGINT))
  declare bigRange: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.DECIMAL))
  declare priceRange: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.DATEONLY))
  declare available: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.DATE))
  declare validDuring: CreationOptional<unknown | null>;

  @Attribute(DataTypes.INET)
  declare lastIp: CreationOptional<string | null>;

  @Attribute(DataTypes.INET)
  @Unique
  declare legacyIp: CreationOptional<string | null>;

  @Attribute(DataTypes.BIGINT)
  declare shelfLife: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare sourcePath: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare manual: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare photo: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(0)
  declare smallCount: CreationOptional<number>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(0)
  declare tinyCount: CreationOptional<number>;

  @Attribute(DataTypes.BOOLEAN)
  @NotNull
  @Default(true)
  declare isActive: CreationOptional<boolean>;

  @Attribute(DataTypes.DATE)
  @NotNull
  @Default(DataTypes.NOW)
  declare stockedAt: CreationOptional<Date>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(5)
  declare priority: CreationOptional<number>;

  @Attribute(DataTypes.STRING(20))
  @NotNull
  @Default('none')
  declare note: CreationOptional<string>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  declare shipments?: NonAttribute<Shipment[]>;
  declare otherShipments?: NonAttribute<Shipment[]>;
}
