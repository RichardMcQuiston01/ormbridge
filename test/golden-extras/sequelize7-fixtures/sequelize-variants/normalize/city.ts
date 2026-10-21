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
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Country } from './country.js';

@Table({ tableName: 'city', timestamps: true, underscored: true })
export class City extends Model<
  InferAttributes<City>,
  InferCreationAttributes<City>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(255))
  declare name: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.STRING(2))
  declare countryCode: CreationOptional<string | null>;

  @BelongsTo(() => Country, {
    foreignKey: { name: 'countryCode', onDelete: 'CASCADE' },
  })
  declare country?: NonAttribute<Country>;
}
