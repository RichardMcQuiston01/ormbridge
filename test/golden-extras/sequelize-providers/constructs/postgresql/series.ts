import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';

export class Series extends Model<
  InferAttributes<Series>,
  InferCreationAttributes<Series>
> {
  declare id: CreationOptional<number>;
  declare handle: string;
  declare parent_id: CreationOptional<number | null>;

  declare parent?: NonAttribute<Series>;
  declare children?: NonAttribute<Series[]>;

  static initModel(sequelize: Sequelize): typeof Series {
    Series.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        handle: {
          type: DataTypes.STRING(20),
          allowNull: false,
          unique: 'series_handle_uq',
        },
        parent_id: DataTypes.INTEGER,
      },
      { sequelize, modelName: 'Series', tableName: 'series', timestamps: false }
    );
    return Series;
  }
}
